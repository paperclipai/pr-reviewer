/**
 * Local-only D1 read-cost proxy. Run with Node >=22.18:
 *   node --experimental-strip-types scripts/measure-read-cost.ts [baseline-ref]
 *
 * Creates synthetic data under /tmp, imports the baseline and working-tree
 * implementations, captures their actual SQL, and measures it using SQLite's
 * sqlite3_stmt_scanstatus API. Does not load configuration, call GitHub/Cloudflare,
 * or change data outside its temporary directory. Requires a C compiler; builds
 * a local scanstatus harness from better-sqlite3's bundled SQLite amalgamation.
 *
 * SQLite visits are not D1 billing: notably SQLite's fast COUNT(*) opcode reports
 * no scan rows. We report those table cardinalities separately, not as zero cost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require('typescript');
// Import the source directly without overwriting the repository's build output.
require.extensions['.ts'] = (module: any, filename: string) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true }, fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fingerprints = () => Object.fromEntries(['src/web/routes.ts', 'src/web/read-cache.ts',
  'src/github/users.ts', 'src/github/sync-refresh.ts'].filter(file => fs.existsSync(path.join(root, file)))
  .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const sourceAtStart = fingerprints();
const baselineRef = process.argv[2] ?? '3dec121';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-triage-read-cost-'));
// macOS sqlite3 3.51.0's .scanstats crashes on COUNT(DISTINCT). Use the SQLite
// version bundled with this repository and the scanstatus C API directly.
const harness = path.join(temp, 'scanstatus');
const harnessSource = path.join(temp, 'scanstatus.c');
fs.writeFileSync(harnessSource, `
#include <stdio.h>
#include <stdlib.h>
#include "sqlite3.h"
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  sqlite3 *db = 0;
  if (sqlite3_open(argv[1], &db) != SQLITE_OK) return 3;
  FILE *input = fopen(argv[2], "rb");
  if (!input) return 4;
  fseek(input, 0, SEEK_END); long size = ftell(input); rewind(input);
  char *text = calloc((size_t)size + 1, 1);
  if (fread(text, 1, (size_t)size, input) != (size_t)size) return 5;
  fclose(input);
  const char *next = text, *tail = 0; int query = 0;
  while (*next) {
    sqlite3_stmt *statement = 0;
    if (sqlite3_prepare_v2(db, next, -1, &statement, &tail) != SQLITE_OK) {
      fprintf(stderr, "prepare: %s\\n", sqlite3_errmsg(db)); return 6;
    }
    next = tail;
    if (!statement) continue;
    int result;
    while ((result = sqlite3_step(statement)) == SQLITE_ROW) {}
    if (result != SQLITE_DONE) {
      fprintf(stderr, "step: %s\\n", sqlite3_errmsg(db)); return 7;
    }
    printf("QUERY_%d\\n", query++);
    for (int index = 0;; index++) {
      sqlite3_int64 visits = 0, loops = 0; const char *explain = 0;
      if (sqlite3_stmt_scanstatus(statement, index, SQLITE_SCANSTAT_NVISIT, &visits)) break;
      sqlite3_stmt_scanstatus(statement, index, SQLITE_SCANSTAT_NLOOP, &loops);
      sqlite3_stmt_scanstatus(statement, index, SQLITE_SCANSTAT_EXPLAIN, &explain);
      printf("%s (loops=%lld rows=%lld)\\n", explain, (long long)loops, (long long)visits);
    }
    sqlite3_finalize(statement);
  }
  free(text); sqlite3_close(db); return 0;
}
`);
const sqliteSource = path.join(root, 'node_modules/better-sqlite3/deps/sqlite3');
execFileSync('clang', ['-O2', '-DSQLITE_ENABLE_STMT_SCANSTATUS', '-DSQLITE_ENABLE_FTS5',
  '-I', sqliteSource, harnessSource, path.join(sqliteSource, 'sqlite3.c'), '-lm', '-o', harness], {
  maxBuffer: 4 * 1024 * 1024,
});
const baselineRoot = path.join(temp, 'baseline');
fs.mkdirSync(baselineRoot);
const baselineCommit = execFileSync('git', ['rev-parse', baselineRef], { cwd: root, encoding: 'utf8' }).trim();
for (const filename of execFileSync('git', ['ls-tree', '-r', '--name-only', baselineCommit, 'src'], {
  cwd: root, encoding: 'utf8',
}).trim().split('\n')) {
  const destination = path.join(baselineRoot, filename);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, execFileSync('git', ['show', `${baselineCommit}:${filename}`], { cwd: root }));
}
fs.symlinkSync(path.join(root, 'node_modules'), path.join(baselineRoot, 'node_modules'), 'dir');
const load = (directory: string, name: string) => require(path.join(directory, 'src', name));
const { SqliteClient } = load(root, 'db/sqlite.ts');
const fixturePath = path.join(temp, 'fixture.sqlite');
const fixture = new SqliteClient(fixturePath);
await load(baselineRoot, 'db/bootstrap.ts').initializeDb(fixture);
const raw = fixture.db;
const now = Date.UTC(2026, 9, 2, 12);
const originalNow = Date.now;
Date.now = () => now;
const date = (index: number) => new Date(now - (index % 30) * 86400000).toISOString();

raw.transaction(() => {
  const pr = raw.prepare(`INSERT INTO pull_requests
    (number,title,body,author,author_handle,head_sha,mergeable,mergeable_state,state,labels_json,
     additions,deletions,changed_files,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,'clean',?,'[]',?,?,15,?,?)`);
  const comment = raw.prepare(`INSERT INTO pr_comments
    (comment_id,pr_number,author,author_handle,body,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`);
  const file = raw.prepare('INSERT INTO pr_files(pr_number,filename,status) VALUES (?,?,?)');
  const check = raw.prepare(`INSERT INTO check_runs(pr_number,name,status,conclusion,updated_at)
    VALUES (?,?,'completed',?,?)`);
  const score = raw.prepare(`INSERT INTO greptile_scores
    (pr_number,comment_id,confidence_score,comment_body,created_at) VALUES (?,?,?,'Review',?)`);
  const review = raw.prepare(`INSERT INTO llm_reviews(pr_number,review_json,model,prompt_version)
    VALUES (?,'{}','fixture','1')`);
  for (let i = 1; i <= 11000; i++) {
    const owner = i % 1000;
    const body = `Topic ${i % 79}: change the implementation for module ${i % 131}. ` +
      `Add validation and support for workflow ${i % 41}; preserve compatible behavior. ` +
      (i % 5 === 0 ? 'Thinking path: consider existing usage. ' : '') +
      (i % 7 === 0 ? `Fixes #${i + 50}.` : '');
    // One account deliberately has mixed display casing across its PRs.
    const author = owner === 1 ? (i % 3 === 0 ? 'USER1' : 'user1') : `User${owner}`;
    pr.run(i, `Improve topic ${i % 79} for module ${i % 131}`, body,
      author, `user${owner}`, `sha-${i}`,
      i <= 3500 ? 'open' : i % 3 === 0 ? 'closed' : 'merged', i % 600, i % 80, date(i), date(i + 1));
    for (let j = 0; j < 15; j++) {
      const name = j === 0 && i % 3 === 0 ? `src/topic${i % 100}/file.test.ts` :
        `src/topic${i % 100}/file${(i + j) % 300}.ts`;
      file.run(i, name, 'modified');
    }
    if (i <= 3500) {
      check.run(i, 'tests', i % 9 === 0 ? 'failure' : 'success', date(i));
      check.run(i, 'lint', 'success', date(i));
    }
    if (i % 4 === 0) score.run(i, 100000 + i, i % 5 + 1, date(i));
    if (i % 20 === 0) review.run(i);
  }
  for (let i = 1; i <= 25000; i++) {
    const owner = i % 1500;
    comment.run(i, i % 11000 + 1, `User${owner}`, `user${owner}`,
      `Fixture comment ${i}: topic ${i % 79}`, date(i), date(i));
  }
  raw.prepare('INSERT INTO sync_state(key,value) VALUES (?,?)').run('last_sync_at', '2026-10-02 11:00:00');
  raw.prepare('INSERT INTO sync_state(key,value) VALUES (?,?)').run('merged_count', '5000');
  raw.prepare('INSERT INTO sync_state(key,value) VALUES (?,?)').run('closed_count', '2500');
  raw.prepare('INSERT INTO sync_state(key,value) VALUES (?,?)').run('incremental_users_version', '1');
})();
await load(baselineRoot, 'github/users.ts').rebuildGitHubUsers(fixture);
// Simulate the source/summary gap during an in-progress contributor refresh.
await fixture.run("DELETE FROM github_users WHERE handle = 'user2'");
await fixture.close();

type Statement = { sql: string; params: any[] };
function recordingDb(db: any, statements: Statement[]) {
  return Object.fromEntries(['get', 'all', 'run', 'exec', 'runBatch', 'close'].map(method => [method,
    async (sql: any, params: any[] = []) => {
      if (method === 'runBatch') statements.push(...sql);
      else if (method !== 'close') statements.push({ sql, params });
      return db[method](sql, params);
    }]));
}

function bind(statement: Statement): string {
  let index = 0;
  const sql = statement.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) => {
    if (token !== '?') return token;
    if (index >= statement.params.length) throw new Error('Too few SQL parameters');
    const value = statement.params[index++];
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    return `'${String(value).replaceAll("'", "''")}'`;
  });
  if (index !== statement.params.length) throw new Error('Too many SQL parameters');
  return sql.trim().replace(/;$/, '') + ';';
}

function measure(name: string, statements: Statement[]) {
  const replay = path.join(temp, `${name}.replay.sqlite`);
  fs.copyFileSync(fixturePath, replay);
  const script = statements.map(bind).join('\n');
  const scriptPath = path.join(temp, `${name}.sql`);
  fs.writeFileSync(scriptPath, script);
  const output = execFileSync(harness, [replay, scriptPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(temp, `${name}.scanstats.txt`), output);
  const scanRows = [...output.matchAll(/\brows=(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  // Op_Count bypasses scanstatus; its rows are meaningful to D1 even though
  // native SQLite retrieves B-tree cardinality without visiting every row.
  let fastCountCardinality = 0;
  const cardinalities: Record<string, number> = { pull_requests: 11000, pr_comments: 25000,
    pr_files: 165000, github_users: 1499, check_runs: 7000, greptile_scores: 2750, llm_reviews: 550 };
  for (const statement of statements) {
    const match = statement.sql.trim().match(/^SELECT COUNT\(\*\)\s+(?:AS\s+)?\w+\s+FROM\s+(\w+)\s*;?$/i);
    if (match) fastCountCardinality += cardinalities[match[1]] ?? 0;
  }
  return { queries: statements.length, scanRows, fastCountCardinality,
    readWorkProxy: scanRows + fastCountCardinality };
}

function canonical(value: any): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

const routeCases = {
  list: '/prs',
  authorList: '/prs?state=all&author=USER704',
  mixedCaseAuthor: '/prs?state=all&author=USER1',
  missingSummary: '/prs?state=all&author=USER2',
  detail: '/prs/9704',
  profile: '/github-users/user704',
  stats: '/stats',
  similar: '/prs/9704/similar',
};
const results: Record<string, any> = {};
for (const [name, url] of Object.entries(routeCases)) {
  const payloads: any[] = [];
  const pair: Record<string, any> = {};
  for (const [label, directory] of [['before', baselineRoot], ['after', root]]) {
    const db = new SqliteClient(fixturePath);
    const statements: Statement[] = [];
    const routes = load(directory, 'web/routes.ts').createRoutes(async () => recordingDb(db, statements));
    const started = performance.now();
    const response = await routes.request('http://fixture.test' + url);
    const json = await response.json();
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    if (response.status !== 200) throw new Error(`${label} ${name}: ${response.status} ${JSON.stringify(json)}`);
    payloads.push(json);
    await db.close();
    fs.writeFileSync(path.join(temp, `${name}-${label}.json`), JSON.stringify(json, null, 2));
    pair[label] = { ...measure(`${name}-${label}`, statements), elapsedMs };
  }
  pair.identicalJson = canonical(payloads[0]) === canonical(payloads[1]);
  if (name === 'similar') pair.identicalRanking = canonical(payloads[0].similar.map((pr: any) => pr.number)) === canonical(payloads[1].similar.map((pr: any) => pr.number));
  results[name] = pair;
  console.log(name, JSON.stringify(pair));
}

for (const [name, directory, handles] of [
  ['fullRefresh', baselineRoot, undefined],
  ['targetedRefresh', root, ['user704']],
  ['unchangedRefresh', root, []],
] as const) {
  const dbPath = path.join(temp, `${name}.sqlite`);
  fs.copyFileSync(fixturePath, dbPath);
  const db = new SqliteClient(dbPath);
  const statements: Statement[] = [];
  const started = performance.now();
  await load(directory, 'github/users.ts').rebuildGitHubUsers(recordingDb(db, statements), handles);
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  await db.close();
  results[name] = { ...measure(name, statements), elapsedMs };
  console.log(name, JSON.stringify(results[name]));
}

if (fs.existsSync(path.join(root, 'src/github/sync-refresh.ts'))) {
  const db = new SqliteClient(fixturePath);
  const statements: Statement[] = [];
  await load(root, 'github/sync-refresh.ts').refreshPendingUsers(recordingDb(db, statements));
  results.unchangedSyncRefresh = measure('unchangedSyncRefresh', statements);
  console.log('unchangedSyncRefresh', JSON.stringify(results.unchangedSyncRefresh));
  await db.close();
}

// Verify that a real source change has the same aggregate result in both modes.
const contributorPayloads: any[] = [];
for (const [label, directory, handles] of [
  ['before', baselineRoot, undefined], ['after', root, ['user704']],
] as const) {
  const dbPath = path.join(temp, `changed-contributor-${label}.sqlite`);
  fs.copyFileSync(fixturePath, dbPath);
  const db = new SqliteClient(dbPath);
  await db.run("UPDATE pull_requests SET state = 'closed', updated_at = '2026-10-02T12:00:00.000Z' WHERE number = 9704");
  await db.run("UPDATE pr_comments SET updated_at = '2026-10-02T12:00:00.000Z' WHERE comment_id = 704");
  await load(directory, 'github/users.ts').rebuildGitHubUsers(db, handles);
  // Exclude the deliberately absent *unrelated* summary: only the full repair
  // restores it. Timestamps record refresh time, not contributor contents.
  const rows = await db.all(`SELECT handle,display_handle,pr_count,open_pr_count,
    merged_pr_count,closed_unmerged_pr_count,comment_count,latest_pr_number,
    latest_pr_at,latest_comment_id,latest_comment_at FROM github_users
    WHERE handle != 'user2' ORDER BY handle`);
  contributorPayloads.push(rows);
  await db.close();
}
results.changedContributor = { identicalSummaries: canonical(contributorPayloads[0]) === canonical(contributorPayloads[1]) };
console.log('changedContributor', JSON.stringify(results.changedContributor));

// Exercise the real cache with a real SQLite-backed route. This includes the
// indexed revision read and proves warm hits avoid the expensive query group.
if (fs.existsSync(path.join(root, 'src/web/read-cache.ts'))) {
  const db = new SqliteClient(fixturePath);
  const statements: Statement[] = [];
  const tracked = recordingDb(db, statements);
  const routes = load(root, 'web/routes.ts').createRoutes(async () => tracked);
  let cacheNow = 0;
  const { ReadCache } = load(root, 'web/read-cache.ts');
  const cache = new ReadCache(async () => {
    const row = await tracked.get("SELECT value FROM sync_state WHERE key = 'last_sync_at'");
    return row?.value ?? null;
  }, { now: () => cacheNow });
  const request = new Request('http://fixture.test/api/prs');
  const payloads: any[] = [];
  for (const [name, elapsed] of [['cold', 0], ['warm', 1], ['revisionCheck', 60_001]] as const) {
    cacheNow = elapsed;
    statements.length = 0;
    const response = await cache.fetch(request, async () => routes.request('http://fixture.test/prs'));
    payloads.push(await response.json());
    results[`cache-${name}`] = { ...measure(`cache-${name}`, statements), state: response.headers.get('X-PR-Cache') };
    console.log(`cache-${name}`, JSON.stringify(results[`cache-${name}`]));
  }
  results.cacheParity = payloads.every(value => canonical(value) === canonical(payloads[0]));
  await db.close();
}

Date.now = originalNow;
const sourceAtEnd = fingerprints();
const report = { baselineCommit, sourceAtStart, sourceAtEnd,
  sourcesStableDuringRun: canonical(sourceAtStart) === canonical(sourceAtEnd),
  fixture: { prs: 11000, comments: 25000, files: 165000,
  contributors: 1499, openPRs: 3500, edgeCases: ['mixed-case author', 'one temporarily missing contributor summary'] }, fixedNow: new Date(now).toISOString(),
  caveats: ['Local SQLite row visits, not Cloudflare billed rows.',
    'readWorkProxy adds fast COUNT(*) table cardinalities, which scanstatus does not report.',
    'Timings are single local runs, not Worker CPU measurements.',
    'Warm application-cache behavior is tested separately; these are uncached route costs.'], results };
fs.writeFileSync(path.join(temp, 'results.json'), JSON.stringify(report, null, 2));
console.log('Artifacts:', temp);
if (Object.values(results).some(result => result && typeof result === 'object' &&
    (result.identicalJson === false || result.identicalSummaries === false || result.identicalRanking === false))
    || results.cacheParity === false) process.exitCode = 1;
