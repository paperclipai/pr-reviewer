import { getOctokit, REPO_OWNER, REPO_NAME } from './api';
import { getDb } from '../db/client';
import { BatchStatement } from '../db/types';
import { parseGreptileScores } from './comments';
import { CheckRun } from './checks';
import { normalizeGitHubHandle } from './users';
import { beginPRRefresh, finishPRRefresh, pendingPRs, refreshPendingUsers } from './sync-refresh';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';

export interface SyncOptions {
  full?: boolean;
}

// Both GitHub's list and detail responses provide these fields. Their unused
// label metadata has different nullability, so accept only the fields we read.
interface SyncPRSource {
  number: number;
  title: string;
  body?: string | null;
  user: { login: string } | null;
  head: { sha: string };
  labels: Array<string | { name: string; color: string }>;
  created_at: string;
  updated_at: string;
}

interface SyncPRDetail {
  mergeable: boolean | null;
  mergeable_state: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

export async function syncPullRequests(opts: SyncOptions = {}): Promise<void> {
  const octokit = getOctokit();
  const db = await getDb();
  const token = randomUUID();
  const retryPRs = await pendingPRs(db);
  const incompletePRs = new Set<number>();
  const unavailablePRs = new Set<number>();
  let failures = 0;

  console.log(chalk.blue('Fetching open pull requests...'));

  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: 'open',
    per_page: 100,
  });

  if (opts.full) {
    console.log(chalk.blue(`Found ${prs.length} open PRs. Full sync forced...`));
  } else {
    console.log(chalk.blue(`Found ${prs.length} open PRs. Checking for changes...`));
  }

  // --- Incremental sync: load cached timestamps & head SHAs ---
  const cachedRows = await db.all<{ number: number; updated_at: string; head_sha: string; mergeable: number | null; mergeable_state: string | null }>(
    `SELECT number, updated_at, head_sha, mergeable, mergeable_state FROM pull_requests WHERE state = 'open'`
  );
  const cached = new Map(cachedRows.map(r => [r.number, r]));

  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(10);

  let completed = 0;
  let skipped = 0;

  const syncPR = async (pr: SyncPRSource, state = 'open', prefetchedDetail?: SyncPRDetail) => {
    const existing = cached.get(pr.number);

    // Skip detail fetch if the PR hasn't changed since last sync
    if (state === 'open' && !opts.full && !retryPRs.has(pr.number) && existing && existing.updated_at === pr.updated_at) {
      skipped++;
      completed++;
      process.stdout.write(`\r  ${chalk.green(`${completed}/${prs.length}`)} synced (${chalk.yellow(`${skipped} skipped`)})`);
      return;
    }

    let mergeable: boolean | null = null;
    let mergeableState: string | null = null;
    let additions = 0;
    let deletions = 0;
    let changedFiles = 0;

    // Only call pulls.get (with retry) when head_sha changed; otherwise reuse cached mergeable
    const headShaChanged = !existing || existing.head_sha !== pr.head.sha;

    if (prefetchedDetail) {
      mergeable = prefetchedDetail.mergeable ?? null;
      mergeableState = prefetchedDetail.mergeable_state ?? null;
      additions = prefetchedDetail.additions ?? 0;
      deletions = prefetchedDetail.deletions ?? 0;
      changedFiles = prefetchedDetail.changed_files ?? 0;
    } else if (headShaChanged) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: detail } = await octokit.rest.pulls.get({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number: pr.number,
        });
        mergeable = detail.mergeable;
        mergeableState = detail.mergeable_state;
        additions = detail.additions ?? 0;
        deletions = detail.deletions ?? 0;
        changedFiles = detail.changed_files ?? 0;
        if (mergeable !== null) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } else {
      // head_sha unchanged — reuse cached mergeable, still fetch detail once for LOC stats
      const { data: detail } = await octokit.rest.pulls.get({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        pull_number: pr.number,
      });
      mergeable = existing.mergeable === null ? null : existing.mergeable === 1;
      mergeableState = existing.mergeable_state;
      additions = detail.additions ?? 0;
      deletions = detail.deletions ?? 0;
      changedFiles = detail.changed_files ?? 0;
    }

    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: pr.number,
      per_page: 100,
    });

    const scores = parseGreptileScores(comments);

    const { data: checksData } = await octokit.rest.checks.listForRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: pr.head.sha,
      per_page: 100,
    });

    const checks: CheckRun[] = checksData.check_runs.map(cr => ({
      name: cr.name,
      status: cr.status,
      conclusion: cr.conclusion ?? null,
      updatedAt: cr.completed_at ?? cr.started_at ?? new Date().toISOString(),
    }));

    // Extract labels (name + color)
    const labels = (pr.labels || []).map((l: any) => ({
      name: typeof l === 'string' ? l : l.name,
      color: typeof l === 'string' ? null : l.color,
    }));

    // --- Batch all DB writes for this PR ---
    const batch: BatchStatement[] = [];
    const authorHandle = normalizeGitHubHandle(pr.user?.login ?? 'unknown');

    // Upsert PR
    batch.push({
      sql: `INSERT INTO pull_requests (number, title, body, author, author_handle, head_sha, mergeable, mergeable_state, state, labels_json, additions, deletions, changed_files, created_at, updated_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(number) DO UPDATE SET
        title=excluded.title, body=excluded.body, author=excluded.author, author_handle=excluded.author_handle,
        head_sha=excluded.head_sha, mergeable=excluded.mergeable,
        mergeable_state=excluded.mergeable_state, state=excluded.state, labels_json=excluded.labels_json,
        additions=excluded.additions, deletions=excluded.deletions, changed_files=excluded.changed_files,
        updated_at=excluded.updated_at, fetched_at=datetime('now')`,
      params: [
        pr.number,
        pr.title,
        pr.body ?? null,
        pr.user?.login ?? 'unknown',
        authorHandle,
        pr.head.sha,
        mergeable === null ? null : mergeable ? 1 : 0,
        mergeableState,
        state,
        JSON.stringify(labels),
        additions,
        deletions,
        changedFiles,
        pr.created_at,
        pr.updated_at,
      ],
    });

    // Upsert comments + FTS
    for (const comment of comments) {
      if (!comment.body) continue;
      batch.push({
        sql: `INSERT INTO pr_comments (comment_id, pr_number, author, author_handle, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(comment_id) DO UPDATE SET
          author=excluded.author, author_handle=excluded.author_handle, body=excluded.body, updated_at=excluded.updated_at`,
        params: [
          comment.id,
          pr.number,
          comment.user?.login ?? 'unknown',
          normalizeGitHubHandle(comment.user?.login ?? 'unknown'),
          comment.body,
          comment.created_at,
          comment.updated_at,
        ],
      });
      batch.push({
        sql: `INSERT OR REPLACE INTO pr_comments_fts(rowid, body) VALUES (?, ?)`,
        params: [comment.id, comment.body],
      });
    }

    // Upsert greptile scores
    for (const score of scores) {
      batch.push({
        sql: `INSERT INTO greptile_scores (pr_number, comment_id, confidence_score, comment_body, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(comment_id) DO UPDATE SET
          confidence_score=excluded.confidence_score, comment_body=excluded.comment_body`,
        params: [pr.number, score.commentId, score.confidenceScore, score.commentBody, score.createdAt],
      });
    }

    // Sync changed files
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      pull_number: pr.number,
      per_page: 100,
    });

    batch.push({
      sql: 'DELETE FROM pr_files WHERE pr_number = ?',
      params: [pr.number],
    });
    for (const file of files) {
      batch.push({
        sql: `INSERT INTO pr_files (pr_number, filename, status) VALUES (?, ?, ?)`,
        params: [pr.number, file.filename, file.status],
      });
    }

    // Upsert check runs
    for (const check of checks) {
      batch.push({
        sql: `INSERT INTO check_runs (pr_number, name, status, conclusion, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(pr_number, name) DO UPDATE SET
          status=excluded.status, conclusion=excluded.conclusion, updated_at=excluded.updated_at`,
        params: [pr.number, check.name, check.status, check.conclusion, check.updatedAt],
      });
    }

    await beginPRRefresh(db, pr.number, [authorHandle, ...comments.filter(c => c.body).map(c => c.user?.login ?? 'unknown')], token);
    await db.runBatch(batch);
    await finishPRRefresh(db, pr.number, token);

    if (state === 'open') {
      completed++;
      process.stdout.write(`\r  ${chalk.green(`${completed}/${prs.length}`)} synced (${chalk.yellow(`${skipped} skipped`)})`);
    }
  };

  const tasks = prs.map(pr => limit(async () => {
    try {
      await syncPR(pr);
    } catch (err: any) {
      failures++;
      incompletePRs.add(pr.number);
      completed++;
      console.error(chalk.red(`\nError syncing PR #${pr.number}: ${err.message}`));
    }
  }));

  await Promise.all(tasks);

  // Detect PRs in DB that are no longer open
  const openNumbers = new Set(prs.map(p => p.number));
  const toCheck = [...new Set([...cached.keys(), ...retryPRs])].filter(number => !openNumbers.has(number)).map(number => ({ number }));

  if (toCheck.length > 0) {
    console.log(chalk.blue(`\nChecking ${toCheck.length} PRs no longer open...`));
    const staleLimit = pLimit(10);
    let staleCompleted = 0;
    await Promise.all(toCheck.map(p => staleLimit(async () => {
      let detailFetched = false;
      try {
        const { data } = await octokit.rest.pulls.get({
          owner: REPO_OWNER, repo: REPO_NAME, pull_number: p.number,
        });
        detailFetched = true;
        if (retryPRs.has(p.number)) {
          // A previous REST batch may have stopped after saving updated_at or
          // deleting files. Replay every source write even if GitHub has since
          // closed the PR; a state-only update must not acknowledge that retry.
          await syncPR(data, data.state === 'open' ? 'open' : data.merged ? 'merged' : 'closed', data);
          return;
        }
        if (data.state === 'open') {
          // The list missed a still-open PR. Do not call this a complete sync.
          failures++;
          incompletePRs.add(p.number);
          console.error(chalk.yellow(`\nOpen PR #${p.number} was missing from the list; leaving it for retry`));
          return;
        }
        const newState = data.merged ? 'merged' : 'closed';
        await beginPRRefresh(db, p.number, [], token);
        await db.run(`UPDATE pull_requests SET state = ? WHERE number = ?`, [newState, p.number]);
        await finishPRRefresh(db, p.number, token);
      } catch (err: any) {
        incompletePRs.add(p.number);
        if (!detailFetched && err?.status === 404) {
          // GitHub may hide inaccessible PRs behind 404. Preserve the last
          // known state and any durable replay marker; never assume deletion
          // or closure. Only this historical detail lookup is tolerated.
          unavailablePRs.add(p.number);
          console.warn(chalk.yellow(`\nPR #${p.number} unavailable from GitHub (404); keeping cached data and retrying next sync`));
        } else {
          failures++;
          console.error(chalk.yellow(`\nCould not verify PR #${p.number}, leaving state unchanged: ${err?.message ?? String(err)}`));
        }
      } finally {
        staleCompleted++;
        process.stdout.write(`\r  ${chalk.green(`${staleCompleted}/${toCheck.length}`)} checked`);
      }
    })));
    console.log();
  }

  // Fetch recent merged & closed PRs for author history
  console.log(chalk.blue('\nFetching recent merged/closed PRs for author history...'));
  for (const prState of ['closed'] as const) {
    try {
      const closedPRs = await octokit.paginate(octokit.rest.pulls.list, {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
      }, (response, done) => {
        // Stop after 500 to avoid excessive API usage
        if (response.data.length >= 500) done();
        return response.data;
      });

      let synced = 0;
      for (const cpr of closedPRs.slice(0, 500)) {
        // A scalar history update cannot acknowledge a partial full-source
        // replay. The open/stale paths own these durable retry markers.
        if (retryPRs.has(cpr.number) || incompletePRs.has(cpr.number)) continue;
        const state = cpr.merged_at ? 'merged' : 'closed';
        const author = cpr.user?.login ?? 'unknown';
        const authorHandle = normalizeGitHubHandle(author);
        const old = await db.get<any>('SELECT title, body, author, author_handle, head_sha, state, updated_at FROM pull_requests WHERE number = ?', [cpr.number]);
        if (old && old.title === cpr.title && old.body === (cpr.body ?? null)
            && old.author === author && old.author_handle === authorHandle && old.head_sha === cpr.head.sha
            && old.state === state && old.updated_at === cpr.updated_at) continue;
        await beginPRRefresh(db, cpr.number, [authorHandle], token);
        await db.run(`
          INSERT INTO pull_requests (number, title, body, author, author_handle, head_sha, state, labels_json, created_at, updated_at, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, datetime('now'))
          ON CONFLICT(number) DO UPDATE SET
            title=excluded.title,
            body=excluded.body,
            author=excluded.author,
            author_handle=excluded.author_handle,
            head_sha=excluded.head_sha,
            state=excluded.state,
            updated_at=excluded.updated_at,
            fetched_at=datetime('now')
          WHERE pull_requests.title IS NOT excluded.title
             OR pull_requests.body IS NOT excluded.body
             OR pull_requests.author IS NOT excluded.author
             OR pull_requests.author_handle IS NOT excluded.author_handle
             OR pull_requests.head_sha IS NOT excluded.head_sha
             OR pull_requests.state IS NOT excluded.state
             OR pull_requests.updated_at IS NOT excluded.updated_at
        `, [
          cpr.number, cpr.title, cpr.body ?? null,
          cpr.user?.login ?? 'unknown', normalizeGitHubHandle(cpr.user?.login ?? 'unknown'), cpr.head.sha,
          state, cpr.created_at, cpr.updated_at,
        ]);
        await finishPRRefresh(db, cpr.number, token);
        synced++;
      }
      console.log(chalk.green(`  ${synced} merged/closed PRs synced`));
    } catch (err: any) {
      failures++;
      console.error(chalk.yellow(`Could not fetch closed PRs: ${err.message}`));
    }
  }

  // Fetch closed/merged counts via search API
  console.log(chalk.blue('Fetching closed/merged PR counts...'));
  try {
    const [mergedRes, closedRes] = await Promise.all([
      octokit.rest.search.issuesAndPullRequests({
        q: `repo:${REPO_OWNER}/${REPO_NAME} type:pr is:merged`,
        per_page: 1,
      }),
      octokit.rest.search.issuesAndPullRequests({
        q: `repo:${REPO_OWNER}/${REPO_NAME} type:pr is:closed is:unmerged`,
        per_page: 1,
      }),
    ]);
    await db.run(`INSERT INTO sync_state (key, value) VALUES ('merged_count', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE sync_state.value IS NOT excluded.value`, [String(mergedRes.data.total_count)]);
    await db.run(`INSERT INTO sync_state (key, value) VALUES ('closed_count', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE sync_state.value IS NOT excluded.value`, [String(closedRes.data.total_count)]);
  } catch (err: any) {
    failures++;
    console.error(chalk.yellow(`Could not fetch closed/merged counts: ${err.message}`));
  }

  await refreshPendingUsers(db);
  await db.run(`INSERT INTO sync_state (key, value) VALUES ('unavailable_prs', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE sync_state.value IS NOT excluded.value`, [JSON.stringify([...unavailablePRs].sort((a, b) => a - b))]);
  if (failures) throw new Error(`Sync incomplete: ${failures} operation(s) failed; pending PRs will be retried.`);
  const synced = completed - skipped;
  if (unavailablePRs.size) {
    console.warn(chalk.yellow(`\nSync finished with gaps. ${synced} PRs synced, ${skipped} unchanged (skipped); ${unavailablePRs.size} historical PR(s) unavailable (404). Last complete-sync time unchanged; unavailable PRs will be retried.`));
    return;
  }
  await db.run(`
    INSERT INTO sync_state (key, value) VALUES ('last_sync_at', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=datetime('now')
  `);

  console.log(chalk.green(`\nSync complete. ${synced} PRs synced, ${skipped} unchanged (skipped).`));
}
