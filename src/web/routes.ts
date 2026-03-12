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

function computeCompositeScore(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean, humanComments: number): number {
  let score = 0;
  if (greptileScore !== null) score += greptileScore * 8;
  switch (ciStatus) {
    case 'passing': score += 25; break;
    case 'pending': score += 12; break;
    case 'unknown': score += 8; break;
    case 'failing': score += 0; break;
  }
  score += hasConflicts ? -15 : 15;
  if (humanComments >= 2) score += 20;
  else if (humanComments === 1) score += 10;
  return Math.max(0, Math.min(100, score));
}

function scoreBreakdown(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean, humanComments: number) {
  const greptile = greptileScore !== null ? greptileScore * 8 : 0;
  let ci = 0;
  switch (ciStatus) {
    case 'passing': ci = 25; break;
    case 'pending': ci = 12; break;
    case 'unknown': ci = 8; break;
  }
  const conflicts = hasConflicts ? -15 : 15;
  let comments = 0;
  if (humanComments >= 2) comments = 20;
  else if (humanComments === 1) comments = 10;
  return {
    total: Math.max(0, Math.min(100, greptile + ci + conflicts + comments)),
    greptile: { value: greptile, max: 40, input: greptileScore },
    ci: { value: ci, max: 25, input: ciStatus },
    conflicts: { value: conflicts, range: '-15 to +15', input: hasConflicts },
    humanComments: { value: comments, max: 20, input: humanComments },
  };
}

function buildCandidate(row: any) {
  const ciStatus = deriveCIStatus(row.total_checks, row.failed_checks, row.pending_checks);
  const hasConflicts = row.mergeable === 0 || row.mergeable_state === 'dirty';
  let labels: any[] = [];
  try { labels = JSON.parse(row.labels_json || '[]'); } catch {}
  return {
    number: row.number,
    title: row.title,
    author: row.author,
    state: row.state,
    labels,
    greptileScore: row.greptile_score,
    ciStatus,
    hasConflicts,
    humanComments: row.human_comments,
    compositeScore: computeCompositeScore(row.greptile_score, ciStatus, hasConflicts, row.human_comments),
    createdAt: row.created_at,
    lastActivity: row.last_activity,
  };
}

const PR_SELECT = `
  SELECT
    pr.number, pr.title, pr.author, pr.mergeable, pr.mergeable_state, pr.state, pr.labels_json, pr.created_at, pr.updated_at,
    (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks,
    (SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number AND pc.author NOT LIKE '%[bot]') as human_comments,
    MAX(pr.updated_at, COALESCE((SELECT MAX(pc.created_at) FROM pr_comments pc WHERE pc.pr_number = pr.number), pr.updated_at)) as last_activity
  FROM pull_requests pr`;

/** Create API routes with an injected DB client — no Node.js imports */
export function createRoutes(getDb: () => Promise<DbClient>): Hono {
  const api = new Hono();

  // List PRs with filters and sorting
  api.get('/prs', async (c) => {
    const db = await getDb();

    const minScore = c.req.query('minScore');
    const ci = c.req.query('ci');
    const noConflicts = c.req.query('noConflicts') === 'true';
    const limitStr = c.req.query('limit');
    const state = c.req.query('state') || 'open';
    const author = c.req.query('author');
    const label = c.req.query('label');
    const sort = c.req.query('sort') || 'score';

    const conditions: string[] = [];
    const params: any[] = [];

    if (state !== 'all') {
      conditions.push('pr.state = ?');
      params.push(state);
    }
    if (author) {
      conditions.push('pr.author = ?');
      params.push(author);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await db.all(`${PR_SELECT} ${whereClause} ORDER BY pr.number DESC`, params);

    let candidates = rows.map(buildCandidate);

    if (minScore) candidates = candidates.filter(r => r.greptileScore !== null && r.greptileScore >= parseInt(minScore));
    if (ci && ['passing', 'failing', 'pending'].includes(ci)) candidates = candidates.filter(r => r.ciStatus === ci);
    if (noConflicts) candidates = candidates.filter(r => !r.hasConflicts);
    if (label) {
      const labelLower = label.toLowerCase();
      candidates = candidates.filter(r => r.labels.some((l: any) => l.name.toLowerCase() === labelLower));
    }

    // Sort
    switch (sort) {
      case 'updated':
        candidates.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
        break;
      case 'created':
        candidates.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        break;
      case 'number':
        candidates.sort((a, b) => b.number - a.number);
        break;
      case 'comments':
        candidates.sort((a, b) => b.humanComments - a.humanComments);
        break;
      case 'score':
      default:
        candidates.sort((a, b) => b.compositeScore - a.compositeScore);
        break;
    }

    if (limitStr) candidates = candidates.slice(0, parseInt(limitStr));

    return c.json(candidates);
  });

  // PR detail with computed scores, labels, checks, reviews, and score breakdown
  api.get('/prs/:number', async (c) => {
    const prNumber = parseInt(c.req.param('number'));
    if (isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);

    const db = await getDb();

    const row = await db.get(`${PR_SELECT} WHERE pr.number = ?`, [prNumber]);
    if (!row) return c.json({ error: 'PR not found' }, 404);

    const candidate = buildCandidate(row);
    const breakdown = scoreBreakdown(candidate.greptileScore, candidate.ciStatus, candidate.hasConflicts, candidate.humanComments);

    const pr = await db.get('SELECT * FROM pull_requests WHERE number = ?', [prNumber]);
    const scores = await db.all('SELECT * FROM greptile_scores WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);
    const checks = await db.all('SELECT * FROM check_runs WHERE pr_number = ?', [prNumber]);
    const rawReviews = await db.all('SELECT * FROM llm_reviews WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);

    const reviews = rawReviews.map((r: any) => ({
      ...r,
      review: JSON.parse(r.review_json),
    }));

    return c.json({
      ...candidate,
      body: (pr as any)?.body ?? null,
      headSha: (pr as any)?.head_sha ?? null,
      scoreBreakdown: breakdown,
      greptileScores: scores,
      checks,
      reviews,
    });
  });

  // Full-text search across PR comments (BM25)
  api.get('/search', async (c) => {
    const q = c.req.query('q');
    if (!q || q.trim().length === 0) return c.json({ error: 'Query parameter q is required' }, 400);
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr) : 20;

    const db = await getDb();

    const results = await db.all<{
      comment_id: number; pr_number: number; author: string;
      body: string; created_at: string; rank: number;
    }>(`
      SELECT c.comment_id, c.pr_number, c.author, c.body, c.created_at,
             rank
      FROM pr_comments_fts fts
      JOIN pr_comments c ON c.comment_id = fts.rowid
      WHERE pr_comments_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `, [q, limit]);

    // Group by PR with metadata
    const prNumbers = [...new Set(results.map(r => r.pr_number))];
    const byPR = new Map<number, { pr_number: number; title: string; author: string; state: string; labels: any[]; compositeScore: number; matches: any[] }>();

    for (const num of prNumbers) {
      const row = await db.get(`${PR_SELECT} WHERE pr.number = ?`, [num]);
      if (row) {
        const cand = buildCandidate(row);
        byPR.set(num, { pr_number: cand.number, title: cand.title, author: cand.author, state: cand.state, labels: cand.labels, compositeScore: cand.compositeScore, matches: [] });
      }
    }

    for (const r of results) {
      byPR.get(r.pr_number)?.matches.push(r);
    }

    return c.json({
      query: q,
      totalMatches: results.length,
      prs: [...byPR.values()],
    });
  });

  // Comments for a specific PR
  api.get('/prs/:number/comments', async (c) => {
    const prNumber = parseInt(c.req.param('number'));
    if (isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);
    const db = await getDb();
    const comments = await db.all('SELECT * FROM pr_comments WHERE pr_number = ? ORDER BY created_at ASC', [prNumber]);
    return c.json(comments);
  });

  // List unique labels across all PRs
  api.get('/labels', async (c) => {
    const db = await getDb();
    const rows = await db.all<{ labels_json: string }>('SELECT labels_json FROM pull_requests WHERE labels_json IS NOT NULL AND labels_json != \'[]\'');
    const labelMap = new Map<string, { name: string; color: string | null; count: number }>();
    for (const row of rows) {
      try {
        const labels = JSON.parse(row.labels_json);
        for (const l of labels) {
          const key = l.name.toLowerCase();
          const existing = labelMap.get(key);
          if (existing) { existing.count++; }
          else { labelMap.set(key, { name: l.name, color: l.color, count: 1 }); }
        }
      } catch {}
    }
    const sorted = [...labelMap.values()].sort((a, b) => b.count - a.count);
    return c.json(sorted);
  });

  // List unique authors
  api.get('/authors', async (c) => {
    const db = await getDb();
    const rows = await db.all<{ author: string; cnt: number }>('SELECT author, COUNT(*) as cnt FROM pull_requests GROUP BY author ORDER BY cnt DESC');
    return c.json(rows);
  });

  // Scoring formula explanation
  api.get('/scoring', (_c) => {
    return _c.json({
      description: 'Composite score (0-100) computed from four signals',
      formula: {
        greptile: { weight: '0-40', calculation: 'greptileScore * 8', note: 'Greptile bot confidence score (1-5) from PR comments' },
        ci: { weight: '0-25', values: { passing: 25, pending: 12, unknown: 8, failing: 0 } },
        conflicts: { weight: '-15 to +15', values: { noConflicts: 15, hasConflicts: -15 } },
        humanComments: { weight: '0-20', values: { '0': 0, '1': 10, '2+': 20 }, note: 'Excludes bot comments (authors matching *[bot])' },
      },
      maxScore: 100,
      minScore: 0,
    });
  });

  // Aggregate stats
  api.get('/stats', async (c) => {
    const db = await getDb();
    const total = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pull_requests');
    const open = await db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM pull_requests WHERE state = 'open'");
    const withScores = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT pr_number) as cnt FROM greptile_scores');
    const reviewed = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT pr_number) as cnt FROM llm_reviews');
    const comments = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pr_comments');
    const lastSync = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'last_sync_at'");
    const mergedCount = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'merged_count'");
    const closedCount = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'closed_count'");

    return c.json({
      totalPRs: total?.cnt ?? 0,
      openPRs: open?.cnt ?? 0,
      mergedPRs: mergedCount ? parseInt(mergedCount.value) : 0,
      closedPRs: closedCount ? parseInt(closedCount.value) : 0,
      withGreptileScores: withScores?.cnt ?? 0,
      llmReviewed: reviewed?.cnt ?? 0,
      totalComments: comments?.cnt ?? 0,
      lastSyncAt: lastSync?.value ?? null,
    });
  });

  return api;
}
