import { rebuildGitHubUsers } from '../github/users';
import type { DbClient } from './types';

const initializationPromises = new WeakMap<DbClient, Promise<DbClient>>();
const SCHEMA_VERSION = '2';

async function execStatement(db: DbClient, sql: string): Promise<void> {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  const statement = normalized.endsWith(';') ? normalized : `${normalized};`;
  await db.exec(statement);
}

async function runMigrations(db: DbClient): Promise<void> {
  for (const statement of [
    `ALTER TABLE pull_requests ADD COLUMN state TEXT NOT NULL DEFAULT 'open'`,
    `ALTER TABLE pull_requests ADD COLUMN labels_json TEXT DEFAULT '[]'`,
    `ALTER TABLE pull_requests ADD COLUMN author_handle TEXT`,
    `ALTER TABLE pr_comments ADD COLUMN author_handle TEXT`,
  ]) {
    try {
      await execStatement(db, statement);
    } catch {
      // Already exists
    }
  }

  for (const col of ['additions', 'deletions', 'changed_files']) {
    try {
      await execStatement(db, `ALTER TABLE pull_requests ADD COLUMN ${col} INTEGER DEFAULT 0`);
    } catch {
      // Already exists
    }
  }

  for (const statement of [
    `CREATE INDEX IF NOT EXISTS idx_pr_state ON pull_requests(state)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_pr ON pr_comments(pr_number)`,
    `CREATE INDEX IF NOT EXISTS idx_pr_author_handle ON pull_requests(author_handle)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_author_handle ON pr_comments(author_handle)`,
    `CREATE INDEX IF NOT EXISTS idx_pr_files_pr ON pr_files(pr_number)`,
    `CREATE INDEX IF NOT EXISTS idx_pr_files_filename ON pr_files(filename)`,
    `CREATE INDEX IF NOT EXISTS idx_github_users_pr_count ON github_users(pr_count DESC, comment_count DESC)`,
  ]) {
    try {
      await execStatement(db, statement);
    } catch {
      // Already exists
    }
  }

  try {
    await execStatement(db, `CREATE VIRTUAL TABLE IF NOT EXISTS pr_comments_fts USING fts5(body, content=pr_comments, content_rowid=comment_id)`);
  } catch {
    // FTS optional
  }

  await execStatement(db, `
    CREATE TABLE IF NOT EXISTS github_users (
      handle TEXT PRIMARY KEY,
      display_handle TEXT NOT NULL,
      pr_count INTEGER NOT NULL DEFAULT 0,
      open_pr_count INTEGER NOT NULL DEFAULT 0,
      merged_pr_count INTEGER NOT NULL DEFAULT 0,
      closed_unmerged_pr_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      latest_pr_number INTEGER REFERENCES pull_requests(number) ON DELETE SET NULL,
      latest_pr_at TEXT,
      latest_comment_id INTEGER REFERENCES pr_comments(comment_id) ON DELETE SET NULL,
      latest_comment_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await rebuildGitHubUsers(db);
}

export async function initializeDb<T extends DbClient>(db: T): Promise<T> {
  const existing = initializationPromises.get(db);
  if (existing) return await existing as T;

  const initialization = (async () => {
    if (await shouldInitializeSchema(db)) {
      for (const statement of getSchemaStatements()) {
        const isFts = /CREATE\s+VIRTUAL\s+TABLE/i.test(statement);
        try {
          await execStatement(db, statement);
        } catch (err) {
          if (isFts) {
            console.warn('FTS5 table creation skipped:', (err as Error).message);
          } else {
            throw err;
          }
        }
      }
      await runMigrations(db);
      await db.run(
        `INSERT INTO sync_state (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [SCHEMA_VERSION],
      );
    }
    return db;
  })();

  initializationPromises.set(db, initialization);

  try {
    return await initialization as T;
  } catch (error) {
    initializationPromises.delete(db);
    throw error;
  }
}

export function getSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS pull_requests (
  number INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  mergeable INTEGER,
  mergeable_state TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  labels_json TEXT DEFAULT '[]',
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  changed_files INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS greptile_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  comment_id INTEGER UNIQUE NOT NULL,
  confidence_score INTEGER NOT NULL CHECK(confidence_score BETWEEN 1 AND 5),
  comment_body TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_greptile_pr ON greptile_scores(pr_number);

CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(pr_number, name)
);

CREATE INDEX IF NOT EXISTS idx_checks_pr ON check_runs(pr_number);

CREATE TABLE IF NOT EXISTS llm_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  review_json TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_pr ON llm_reviews(pr_number);

CREATE TABLE IF NOT EXISTS pr_comments (
  comment_id INTEGER PRIMARY KEY,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  author TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_pr ON pr_comments(pr_number);

CREATE VIRTUAL TABLE IF NOT EXISTS pr_comments_fts USING fts5(
  body,
  content=pr_comments,
  content_rowid=comment_id
);

CREATE TABLE IF NOT EXISTS pr_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  filename TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(pr_number, filename)
);

CREATE INDEX IF NOT EXISTS idx_pr_files_pr ON pr_files(pr_number);
CREATE INDEX IF NOT EXISTS idx_pr_files_filename ON pr_files(filename);

CREATE TABLE IF NOT EXISTS github_users (
  handle TEXT PRIMARY KEY,
  display_handle TEXT NOT NULL,
  pr_count INTEGER NOT NULL DEFAULT 0,
  open_pr_count INTEGER NOT NULL DEFAULT 0,
  merged_pr_count INTEGER NOT NULL DEFAULT 0,
  closed_unmerged_pr_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  latest_pr_number INTEGER REFERENCES pull_requests(number) ON DELETE SET NULL,
  latest_pr_at TEXT,
  latest_comment_id INTEGER REFERENCES pr_comments(comment_id) ON DELETE SET NULL,
  latest_comment_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;
}

function getSchemaStatements(): string[] {
  return getSchema()
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function shouldInitializeSchema(db: DbClient): Promise<boolean> {
  try {
    const row = await db.get<{ value: string }>(
      `SELECT value FROM sync_state WHERE key = 'schema_version'`,
    );
    return row?.value !== SCHEMA_VERSION;
  } catch {
    return true;
  }
}
