import { getOctokit, REPO_OWNER, REPO_NAME } from './api';
import { getDb } from '../db/client';
import { parseGreptileScores } from './comments';
import { CheckRun } from './checks';
import chalk from 'chalk';

export async function syncPullRequests(): Promise<void> {
  const octokit = getOctokit();
  const db = await getDb();

  console.log(chalk.blue('Fetching open pull requests...'));

  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: 'open',
    per_page: 100,
  });

  console.log(chalk.blue(`Found ${prs.length} open PRs. Syncing details...`));

  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(10);

  let completed = 0;

  const tasks = prs.map(pr => limit(async () => {
    try {
      let mergeable: boolean | null = null;
      let mergeableState: string | null = null;
      let additions = 0;
      let deletions = 0;
      let changedFiles = 0;

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

      // Upsert PR
      await db.run(`
        INSERT INTO pull_requests (number, title, body, author, head_sha, mergeable, mergeable_state, state, labels_json, additions, deletions, changed_files, created_at, updated_at, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(number) DO UPDATE SET
          title=excluded.title, body=excluded.body, author=excluded.author,
          head_sha=excluded.head_sha, mergeable=excluded.mergeable,
          mergeable_state=excluded.mergeable_state, state='open', labels_json=excluded.labels_json,
          additions=excluded.additions, deletions=excluded.deletions, changed_files=excluded.changed_files,
          updated_at=excluded.updated_at, fetched_at=datetime('now')
      `, [
        pr.number,
        pr.title,
        pr.body ?? null,
        pr.user?.login ?? 'unknown',
        pr.head.sha,
        mergeable === null ? null : mergeable ? 1 : 0,
        mergeableState,
        JSON.stringify(labels),
        additions,
        deletions,
        changedFiles,
        pr.created_at,
        pr.updated_at,
      ]);

      // Upsert all comments
      for (const comment of comments) {
        if (!comment.body) continue;
        await db.run(`
          INSERT INTO pr_comments (comment_id, pr_number, author, body, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(comment_id) DO UPDATE SET
            body=excluded.body, updated_at=excluded.updated_at
        `, [comment.id, pr.number, comment.user?.login ?? 'unknown', comment.body, comment.created_at, comment.updated_at]);

        // Keep FTS index in sync
        await db.run(`INSERT OR REPLACE INTO pr_comments_fts(rowid, body) VALUES (?, ?)`,
          [comment.id, comment.body]);
      }

      // Upsert greptile scores
      for (const score of scores) {
        await db.run(`
          INSERT INTO greptile_scores (pr_number, comment_id, confidence_score, comment_body, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(comment_id) DO UPDATE SET
            confidence_score=excluded.confidence_score, comment_body=excluded.comment_body
        `, [pr.number, score.commentId, score.confidenceScore, score.commentBody, score.createdAt]);
      }

      // Upsert check runs
      for (const check of checks) {
        await db.run(`
          INSERT INTO check_runs (pr_number, name, status, conclusion, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(pr_number, name) DO UPDATE SET
            status=excluded.status, conclusion=excluded.conclusion, updated_at=excluded.updated_at
        `, [pr.number, check.name, check.status, check.conclusion, check.updatedAt]);
      }

      completed++;
      process.stdout.write(`\r  ${chalk.green(`${completed}/${prs.length}`)} synced`);
    } catch (err: any) {
      completed++;
      console.error(chalk.red(`\nError syncing PR #${pr.number}: ${err.message}`));
    }
  }));

  await Promise.all(tasks);

  // Detect PRs in DB that are no longer open
  const openNumbers = new Set(prs.map(p => p.number));
  const stalePRs = await db.all<{ number: number }>(`SELECT number FROM pull_requests WHERE state = 'open'`);
  const toCheck = stalePRs.filter(p => !openNumbers.has(p.number));

  if (toCheck.length > 0) {
    console.log(chalk.blue(`\nChecking ${toCheck.length} PRs no longer open...`));
    const staleLimit = pLimit(10);
    let staleCompleted = 0;
    await Promise.all(toCheck.map(p => staleLimit(async () => {
      try {
        const { data } = await octokit.rest.pulls.get({
          owner: REPO_OWNER, repo: REPO_NAME, pull_number: p.number,
        });
        const newState = data.merged ? 'merged' : 'closed';
        await db.run(`UPDATE pull_requests SET state = ? WHERE number = ?`, [newState, p.number]);
      } catch {
        await db.run(`UPDATE pull_requests SET state = 'closed' WHERE number = ?`, [p.number]);
      }
      staleCompleted++;
      process.stdout.write(`\r  ${chalk.green(`${staleCompleted}/${toCheck.length}`)} checked`);
    })));
    console.log();
  }

  // Fetch closed/merged counts via search API
  console.log(chalk.blue('\nFetching closed/merged PR counts...'));
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
    await db.run(`INSERT INTO sync_state (key, value) VALUES ('merged_count', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(mergedRes.data.total_count)]);
    await db.run(`INSERT INTO sync_state (key, value) VALUES ('closed_count', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(closedRes.data.total_count)]);
  } catch (err: any) {
    console.error(chalk.yellow(`Could not fetch closed/merged counts: ${err.message}`));
  }

  await db.run(`
    INSERT INTO sync_state (key, value) VALUES ('last_sync_at', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=datetime('now')
  `);

  console.log(chalk.green(`\nSync complete. ${completed} PRs processed.`));
}
