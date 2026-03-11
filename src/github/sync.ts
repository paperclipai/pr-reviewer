import { getOctokit, REPO_OWNER, REPO_NAME } from './api';
import { getDb } from '../db/client';
import { parseGreptileScores } from './comments';
import { CheckRun } from './checks';
import chalk from 'chalk';

export async function syncPullRequests(): Promise<void> {
  const octokit = getOctokit();
  const db = getDb();

  console.log(chalk.blue('Fetching open pull requests...'));

  // Paginate all open PRs
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: 'open',
    per_page: 100,
  });

  console.log(chalk.blue(`Found ${prs.length} open PRs. Syncing details...`));

  // Prepare DB statements
  const upsertPR = db.prepare(`
    INSERT INTO pull_requests (number, title, body, author, head_sha, mergeable, mergeable_state, created_at, updated_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(number) DO UPDATE SET
      title=excluded.title, body=excluded.body, author=excluded.author,
      head_sha=excluded.head_sha, mergeable=excluded.mergeable,
      mergeable_state=excluded.mergeable_state, updated_at=excluded.updated_at,
      fetched_at=datetime('now')
  `);

  const upsertScore = db.prepare(`
    INSERT INTO greptile_scores (pr_number, comment_id, confidence_score, comment_body, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(comment_id) DO UPDATE SET
      confidence_score=excluded.confidence_score, comment_body=excluded.comment_body
  `);

  const upsertCheck = db.prepare(`
    INSERT INTO check_runs (pr_number, name, status, conclusion, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(pr_number, name) DO UPDATE SET
      status=excluded.status, conclusion=excluded.conclusion, updated_at=excluded.updated_at
  `);

  // Dynamic import for p-limit (ESM)
  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(10);

  let completed = 0;

  const tasks = prs.map(pr => limit(async () => {
    try {
      // Fetch individual PR for mergeable field (may need retries)
      let mergeable: boolean | null = null;
      let mergeableState: string | null = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: detail } = await octokit.rest.pulls.get({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number: pr.number,
        });
        mergeable = detail.mergeable;
        mergeableState = detail.mergeable_state;
        if (mergeable !== null) break;
        // GitHub may need time to compute mergeable
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Fetch issue comments for greptile scores
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        issue_number: pr.number,
        per_page: 100,
      });

      const scores = parseGreptileScores(comments);

      // Fetch check runs
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

      // Write to DB in a transaction
      db.transaction(() => {
        upsertPR.run(
          pr.number,
          pr.title,
          pr.body ?? null,
          pr.user?.login ?? 'unknown',
          pr.head.sha,
          mergeable === null ? null : mergeable ? 1 : 0,
          mergeableState,
          pr.created_at,
          pr.updated_at,
        );

        for (const score of scores) {
          upsertScore.run(pr.number, score.commentId, score.confidenceScore, score.commentBody, score.createdAt);
        }

        for (const check of checks) {
          upsertCheck.run(pr.number, check.name, check.status, check.conclusion, check.updatedAt);
        }
      })();

      completed++;
      process.stdout.write(`\r  ${chalk.green(`${completed}/${prs.length}`)} synced`);
    } catch (err: any) {
      completed++;
      console.error(chalk.red(`\nError syncing PR #${pr.number}: ${err.message}`));
    }
  }));

  await Promise.all(tasks);

  // Update sync state
  db.prepare(`
    INSERT INTO sync_state (key, value) VALUES ('last_sync_at', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=datetime('now')
  `).run();

  console.log(chalk.green(`\nSync complete. ${completed} PRs processed.`));
}
