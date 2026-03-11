import { Hono } from 'hono';
import type { DbClient } from '../db/types';

export type { DbClient };

// CI status derivation (inlined to avoid importing from github/checks which is Node-only)
type CIStatus = 'passing' | 'failing' | 'pending' | 'unknown';

function deriveCIStatus(totalChecks: number, failedChecks: number, pendingChecks: number): CIStatus {
  if (totalChecks === 0) return 'unknown';
  if (failedChecks > 0) return 'failing';
  if (pendingChecks > 0) return 'pending';
  return 'passing';
}

function computeCompositeScore(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean): number {
  let score = 0;
  if (greptileScore !== null) score += greptileScore * 10;
  switch (ciStatus) {
    case 'passing': score += 30; break;
    case 'pending': score += 15; break;
    case 'unknown': score += 10; break;
    case 'failing': score += 0; break;
  }
  score += hasConflicts ? -20 : 20;
  return Math.max(0, Math.min(100, score));
}

/** Create API routes with an injected DB client — no Node.js imports */
export function createRoutes(getDb: () => Promise<DbClient>): Hono {
  const api = new Hono();

  api.get('/prs', async (c) => {
    const db = await getDb();

    const minScore = c.req.query('minScore');
    const ci = c.req.query('ci');
    const noConflicts = c.req.query('noConflicts') === 'true';
    const limitStr = c.req.query('limit');

    const rows = await db.all<{
      number: number; title: string; author: string;
      mergeable: number | null; mergeable_state: string | null;
      created_at: string; greptile_score: number | null;
      total_checks: number; failed_checks: number; pending_checks: number;
    }>(`
      SELECT
        pr.number, pr.title, pr.author, pr.mergeable, pr.mergeable_state, pr.created_at,
        (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
        (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
        (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
        (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks
      FROM pull_requests pr
      ORDER BY pr.number DESC
    `);

    let candidates = rows.map(row => {
      const ciStatus = deriveCIStatus(row.total_checks, row.failed_checks, row.pending_checks);
      const hasConflicts = row.mergeable === 0 || row.mergeable_state === 'dirty';
      return {
        number: row.number,
        title: row.title,
        author: row.author,
        greptileScore: row.greptile_score,
        ciStatus,
        hasConflicts,
        compositeScore: computeCompositeScore(row.greptile_score, ciStatus, hasConflicts),
        createdAt: row.created_at,
      };
    });

    if (minScore) candidates = candidates.filter(r => r.greptileScore !== null && r.greptileScore >= parseInt(minScore));
    if (ci && ['passing', 'failing', 'pending'].includes(ci)) candidates = candidates.filter(r => r.ciStatus === ci);
    if (noConflicts) candidates = candidates.filter(r => !r.hasConflicts);
    candidates.sort((a, b) => b.compositeScore - a.compositeScore);
    if (limitStr) candidates = candidates.slice(0, parseInt(limitStr));

    return c.json(candidates);
  });

  api.get('/prs/:number', async (c) => {
    const prNumber = parseInt(c.req.param('number'));
    if (isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);

    const db = await getDb();
    const pr = await db.get('SELECT * FROM pull_requests WHERE number = ?', [prNumber]);
    if (!pr) return c.json({ error: 'PR not found' }, 404);

    const scores = await db.all('SELECT * FROM greptile_scores WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);
    const checks = await db.all('SELECT * FROM check_runs WHERE pr_number = ?', [prNumber]);
    const rawReviews = await db.all('SELECT * FROM llm_reviews WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);

    const reviews = rawReviews.map((r: any) => ({
      ...r,
      review: JSON.parse(r.review_json),
    }));

    return c.json({ pr, scores, checks, reviews });
  });

  api.get('/stats', async (c) => {
    const db = await getDb();
    const total = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pull_requests');
    const withScores = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT pr_number) as cnt FROM greptile_scores');
    const reviewed = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT pr_number) as cnt FROM llm_reviews');
    const lastSync = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'last_sync_at'");

    return c.json({
      totalPRs: total?.cnt ?? 0,
      withGreptileScores: withScores?.cnt ?? 0,
      llmReviewed: reviewed?.cnt ?? 0,
      lastSyncAt: lastSync?.value ?? null,
    });
  });

  return api;
}
