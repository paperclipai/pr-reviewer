import { Hono } from 'hono';
import type { DbClient } from '../db/types';
import {
  deriveCIStatus, computeBaseScore, computeContributorScore, computeCompositeScore,
  computeFullBreakdown, contributorPts, testPts, thinkingPathPts, issueLinkPts,
  freshnessPts, detectThinkingPath, detectIssueLink, scoringFormulaDescription,
  MAX_SCORE, TEST_FILE_SQL, THINKING_PATH_SQL, ISSUE_LINK_SQL,
  type AuthorStats,
} from '../scoring';
import { githubAuthorProfilePath, normalizeGitHubHandle } from '../github/users';

export type { DbClient };

// --- Row-to-candidate mapping (DB shape knowledge stays here) ---

function excerpt(text: string | null | undefined, maxLength: number = 180): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function buildGitHubAuthor(handle: string | null | undefined, fallback: string | null | undefined) {
  const authorHandle = normalizeGitHubHandle(handle ?? fallback);
  return {
    author: fallback ?? authorHandle,
    authorHandle,
    authorProfileUrl: githubAuthorProfilePath(authorHandle),
  };
}

function buildCandidate(row: any) {
  const ciStatus = deriveCIStatus(row.total_checks, row.failed_checks, row.pending_checks);
  const hasConflicts = row.mergeable === 0 || row.mergeable_state === 'dirty';
  let labels: any[] = [];
  try { labels = JSON.parse(row.labels_json || '[]'); } catch {}
  const author = buildGitHubAuthor(row.author_handle, row.author_display_handle ?? row.author);
  return {
    number: row.number,
    title: row.title,
    author: author.author,
    authorHandle: author.authorHandle,
    authorProfileUrl: author.authorProfileUrl,
    state: row.state,
    labels,
    greptileScore: row.greptile_score,
    ciStatus,
    hasConflicts,
    humanComments: row.human_comments,
    compositeScore: computeBaseScore(row.greptile_score, ciStatus, hasConflicts, row.human_comments, row.additions ?? 0, row.deletions ?? 0),
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
    changedFiles: row.changed_files ?? 0,
    createdAt: row.created_at,
    lastActivity: row.last_activity,
  };
}

const PR_SELECT = `
  SELECT
    pr.number, pr.title, pr.body, pr.author,
    COALESCE(pr.author_handle, LOWER(pr.author)) as author_handle,
    COALESCE(gu.display_handle, pr.author) as author_display_handle,
    pr.mergeable, pr.mergeable_state, pr.state, pr.labels_json,
    pr.additions, pr.deletions, pr.changed_files,
    pr.created_at, pr.updated_at,
    (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks,
    (SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number AND pc.author NOT LIKE '%[bot]') as human_comments,
    MAX(pr.updated_at, COALESCE((SELECT MAX(pc.created_at) FROM pr_comments pc WHERE pc.pr_number = pr.number), pr.updated_at)) as last_activity
  FROM pull_requests pr
  LEFT JOIN github_users gu ON gu.handle = COALESCE(pr.author_handle, LOWER(pr.author))`;

// --- Similarity helpers ---

function tokenize(text: string): string[] {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

function wordShingles(words: string[], n: number): Set<string> {
  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(' '));
  }
  return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function extractDirs(filename: string): string[] {
  const parts = filename.split('/');
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join('/'));
  }
  return dirs;
}

// --- Batch author stats helper ---

function buildAuthorMap(rows: Array<{ author: string; state: string; cnt: number }>): Map<string, AuthorStats> {
  const authorMap = new Map<string, AuthorStats>();
  for (const r of rows) {
    if (!authorMap.has(r.author)) {
      authorMap.set(r.author, { openCount: 0, mergedCount: 0, closedCount: 0, totalCount: 0, mergeRate: 0, isFirstContribution: false });
    }
    const s = authorMap.get(r.author)!;
    if (r.state === 'open') s.openCount = r.cnt;
    else if (r.state === 'merged') s.mergedCount = r.cnt;
    else if (r.state === 'closed') s.closedCount = r.cnt;
  }
  for (const [, s] of authorMap) {
    s.totalCount = s.openCount + s.mergedCount + s.closedCount;
    const decided = s.mergedCount + s.closedCount;
    s.mergeRate = decided > 0 ? s.mergedCount / decided : 0;
    s.isFirstContribution = s.totalCount === 1;
  }
  return authorMap;
}

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
      conditions.push('COALESCE(pr.author_handle, LOWER(pr.author)) = ?');
      params.push(normalizeGitHubHandle(author));
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await db.all(`${PR_SELECT} ${whereClause} ORDER BY pr.number DESC`, params);

    let candidates = rows.map(buildCandidate);

    // Batch queries for bonus signals
    const [authorStatRows, testFileRows, tpRows, issueRows] = await Promise.all([
      db.all<{ author: string; state: string; cnt: number }>('SELECT author, state, COUNT(*) as cnt FROM pull_requests GROUP BY author, state'),
      db.all<{ pr_number: number }>(`SELECT DISTINCT pr_number FROM pr_files WHERE ${TEST_FILE_SQL}`),
      db.all<{ number: number }>(`SELECT number FROM pull_requests WHERE ${THINKING_PATH_SQL}`),
      db.all<{ number: number }>(`SELECT number FROM pull_requests WHERE ${ISSUE_LINK_SQL}`),
    ]);

    const authorMap = buildAuthorMap(authorStatRows);
    const prsWithTests = new Set(testFileRows.map(r => r.pr_number));
    const prsWithThinkingPath = new Set(tpRows.map(r => r.number));
    const prsWithIssueLink = new Set(issueRows.map(r => r.number));
    const now = Date.now();

    // Enrich candidates with all scoring signals
    for (const c of candidates as any[]) {
      const stats = authorMap.get(c.author) || { openCount: 0, mergedCount: 0, closedCount: 0, totalCount: 0, mergeRate: 0, isFirstContribution: true };
      const contrib = computeContributorScore(stats);
      const cPts = contributorPts(contrib.score);
      const tPts = testPts(prsWithTests.has(c.number));
      const tpPts = thinkingPathPts(prsWithThinkingPath.has(c.number));
      const ilPts = issueLinkPts(prsWithIssueLink.has(c.number));
      const fresh = freshnessPts(c.createdAt, now);

      c.contributorPts = cPts;
      c.contributorScore = contrib.score;
      c.hasTests = tPts > 0;
      c.hasThinkingPath = tpPts > 0;
      c.hasIssueLink = ilPts > 0;
      c.compositeScore = computeCompositeScore(c.compositeScore, {
        contributorPts: cPts, testPts: tPts, thinkingPathPts: tpPts,
        issueLinkPts: ilPts, freshnessPts: fresh.pts,
      });
      c.breakdown = computeFullBreakdown(
        c.greptileScore, c.ciStatus, c.hasConflicts, c.humanComments,
        c.additions, c.deletions, cPts, contrib.score,
        tPts, tpPts, ilPts, fresh.pts, fresh.ageDays,
      );
    }

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
      case 'loc':
        candidates.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));
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

    const pr = await db.get('SELECT * FROM pull_requests WHERE number = ?', [prNumber]);
    const scores = await db.all('SELECT * FROM greptile_scores WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);
    const checks = await db.all('SELECT * FROM check_runs WHERE pr_number = ?', [prNumber]);
    const rawReviews = await db.all('SELECT * FROM llm_reviews WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);

    const reviews = rawReviews.map((r: any) => ({
      ...r,
      review: JSON.parse(r.review_json),
    }));

    // Contributor stats
    const authorRows = await db.all<{ state: string }>(
      'SELECT state FROM pull_requests WHERE author = ?', [candidate.author]
    );
    const openCount = authorRows.filter(r => r.state === 'open').length;
    const mergedCount = authorRows.filter(r => r.state === 'merged').length;
    const closedCount = authorRows.filter(r => r.state === 'closed').length;
    const totalCount = authorRows.length;
    const decided = mergedCount + closedCount;
    const mergeRate = decided > 0 ? mergedCount / decided : 0;
    const isFirstContribution = totalCount === 1;

    const authorStats: AuthorStats = { openCount, mergedCount, closedCount, totalCount, mergeRate, isFirstContribution };
    const contributor = computeContributorScore(authorStats);
    const cPts = contributorPts(contributor.score);

    // Bonus signals
    const testFiles = await db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pr_files WHERE pr_number = ? AND (${TEST_FILE_SQL})`, [prNumber]
    );
    const hasTests = (testFiles?.cnt ?? 0) > 0;
    const body = (pr as any)?.body ?? '';
    const hasThinkingPath = detectThinkingPath(body);
    const hasIssueLink = detectIssueLink(body);
    const fresh = freshnessPts(candidate.createdAt);

    const tPts = testPts(hasTests);
    const tpPts = thinkingPathPts(hasThinkingPath);
    const ilPts = issueLinkPts(hasIssueLink);

    const finalScore = computeCompositeScore(candidate.compositeScore, {
      contributorPts: cPts, testPts: tPts, thinkingPathPts: tpPts,
      issueLinkPts: ilPts, freshnessPts: fresh.pts,
    });

    const breakdown = computeFullBreakdown(
      candidate.greptileScore, candidate.ciStatus, candidate.hasConflicts,
      candidate.humanComments, candidate.additions, candidate.deletions,
      cPts, contributor.score, tPts, tpPts, ilPts, fresh.pts, fresh.ageDays,
    );

    return c.json({
      ...candidate,
      compositeScore: finalScore,
      hasTests,
      hasThinkingPath,
      hasIssueLink,
      body,
      headSha: (pr as any)?.head_sha ?? null,
      scoreBreakdown: breakdown,
      greptileScores: scores,
      checks,
      reviews,
      contributor: {
        score: contributor.score,
        breakdown: contributor.breakdown,
        stats: authorStats,
      },
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
      comment_id: number; pr_number: number; author: string; author_handle: string;
      body: string; created_at: string; rank: number;
    }>(`
      SELECT c.comment_id, c.pr_number, c.author, COALESCE(c.author_handle, LOWER(c.author)) as author_handle, c.body, c.created_at,
             rank
      FROM pr_comments_fts fts
      JOIN pr_comments c ON c.comment_id = fts.rowid
      WHERE pr_comments_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `, [q, limit]);

    // Group by PR with metadata
    const prNumbers = [...new Set(results.map(r => r.pr_number))];
    const byPR = new Map<number, { pr_number: number; title: string; author: string; authorHandle: string; authorProfileUrl: string | null; state: string; labels: any[]; compositeScore: number; matches: any[] }>();

    for (const num of prNumbers) {
      const row = await db.get(`${PR_SELECT} WHERE pr.number = ?`, [num]);
      if (row) {
        const cand = buildCandidate(row);
        byPR.set(num, {
          pr_number: cand.number,
          title: cand.title,
          author: cand.author,
          authorHandle: cand.authorHandle,
          authorProfileUrl: cand.authorProfileUrl,
          state: cand.state,
          labels: cand.labels,
          compositeScore: cand.compositeScore,
          matches: [],
        });
      }
    }

    for (const r of results) {
      byPR.get(r.pr_number)?.matches.push({
        ...r,
        authorHandle: normalizeGitHubHandle(r.author_handle ?? r.author),
        authorProfileUrl: githubAuthorProfilePath(r.author_handle ?? r.author),
      });
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
    const comments = await db.all<any>(
      'SELECT *, COALESCE(author_handle, LOWER(author)) as author_handle FROM pr_comments WHERE pr_number = ? ORDER BY created_at ASC',
      [prNumber],
    );
    return c.json(comments.map((comment) => ({
      ...comment,
      authorHandle: normalizeGitHubHandle(comment.author_handle ?? comment.author),
      authorProfileUrl: githubAuthorProfilePath(comment.author_handle ?? comment.author),
    })));
  });

  // Similar / duplicate PR detection
  api.get('/prs/:number/similar', async (c) => {
    const prNumber = parseInt(c.req.param('number'));
    if (isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);

    const db = await getDb();
    const pr = await db.get<{ number: number; title: string; body: string | null; author: string; created_at: string }>(
      'SELECT number, title, body, author, created_at FROM pull_requests WHERE number = ?', [prNumber]
    );
    if (!pr) return c.json({ error: 'PR not found' }, 404);

    const others = await db.all<{ number: number; title: string; body: string | null; author: string; author_handle: string | null; created_at: string; greptile_score: number | null; total_checks: number; failed_checks: number; pending_checks: number; human_comments: number; additions: number | null; deletions: number | null; mergeable: number | null; mergeable_state: string | null }>(
      `SELECT pr.number, pr.title, pr.body, pr.author, COALESCE(pr.author_handle, LOWER(pr.author)) as author_handle, pr.created_at,
        pr.additions, pr.deletions, pr.mergeable, pr.mergeable_state,
        (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
        (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
        (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
        (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks,
        (SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number AND pc.author NOT LIKE '%[bot]') as human_comments
      FROM pull_requests pr WHERE pr.number != ?`, [prNumber]
    );

    const srcFiles = await db.all<{ filename: string }>(
      'SELECT filename FROM pr_files WHERE pr_number = ?', [prNumber]
    );
    const srcFileSet = new Set(srcFiles.map(f => f.filename));
    const srcDirSet = new Set(srcFiles.flatMap(f => extractDirs(f.filename)));

    const allFiles = await db.all<{ pr_number: number; filename: string }>(
      'SELECT pr_number, filename FROM pr_files WHERE pr_number != ?', [prNumber]
    );
    const filesByPR = new Map<number, Set<string>>();
    const dirsByPR = new Map<number, Set<string>>();
    for (const f of allFiles) {
      if (!filesByPR.has(f.pr_number)) {
        filesByPR.set(f.pr_number, new Set());
        dirsByPR.set(f.pr_number, new Set());
      }
      filesByPR.get(f.pr_number)!.add(f.filename);
      for (const dir of extractDirs(f.filename)) {
        dirsByPR.get(f.pr_number)!.add(dir);
      }
    }

    const srcTitleWords = new Set(tokenize(pr.title));
    const srcBodyWords = tokenize(pr.body || '');
    const srcBodyShingles = wordShingles(srcBodyWords, 3);
    const srcBodyBigrams = wordShingles(srcBodyWords, 2);

    const simResults: Array<{
      number: number; title: string; author: string; authorHandle: string; created_at: string;
      score: number; titleSimilarity: number; bodySimilarity: number; fileSimilarity: number;
      overallScore: number; sharedFiles: number;
      potentialCopy: boolean; relationship: string;
    }> = [];

    for (const other of others) {
      const otherTitleWords = new Set(tokenize(other.title));
      const titleSim = jaccard(srcTitleWords, otherTitleWords);

      const otherBodyWords = tokenize(other.body || '');
      const otherBodyShingles = wordShingles(otherBodyWords, 3);
      const otherBodyBigrams = wordShingles(otherBodyWords, 2);

      let bodySim: number;
      if (srcBodyShingles.size >= 3 && otherBodyShingles.size >= 3) {
        bodySim = jaccard(srcBodyShingles, otherBodyShingles);
      } else {
        bodySim = jaccard(srcBodyBigrams, otherBodyBigrams);
      }

      const otherFileSet = filesByPR.get(other.number) || new Set<string>();
      const fileSim = jaccard(srcFileSet, otherFileSet);

      let sharedFiles = 0;
      for (const f of srcFileSet) {
        if (otherFileSet.has(f)) sharedFiles++;
      }

      // Score by text only — file overlap is displayed but doesn't affect ranking
      const overall = titleSim * 0.4 + bodySim * 0.6;

      if (overall < 0.08) continue;

      const sameAuthor = pr.author === other.author;
      const potentialCopy = !sameAuthor && bodySim > 0.5;

      let relationship = 'related';
      if (potentialCopy) {
        relationship = 'potential copy';
      } else if (overall > 0.5) {
        relationship = 'likely duplicate';
      } else if (titleSim > 0.5 && bodySim < 0.15) {
        relationship = 'similar topic';
      }

      const otherCiStatus = deriveCIStatus(other.total_checks, other.failed_checks, other.pending_checks);
      const otherHasConflicts = other.mergeable === 0 || other.mergeable_state === 'dirty';
      const prScore = computeBaseScore(other.greptile_score, otherCiStatus, otherHasConflicts, other.human_comments, other.additions ?? 0, other.deletions ?? 0);

      simResults.push({
        number: other.number,
        title: other.title,
        author: other.author,
        authorHandle: normalizeGitHubHandle(other.author_handle ?? other.author),
        created_at: other.created_at,
        score: prScore,
        titleSimilarity: Math.round(titleSim * 100) / 100,
        bodySimilarity: Math.round(bodySim * 100) / 100,
        fileSimilarity: Math.round(fileSim * 100) / 100,
        overallScore: Math.round(overall * 100) / 100,
        sharedFiles,
        potentialCopy,
        relationship,
      });
    }

    simResults.sort((a, b) => b.overallScore - a.overallScore);

    return c.json({
      pr: prNumber,
      similar: simResults.slice(0, 8),
    });
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
    const rows = await db.all<any>(`
      SELECT
        handle,
        display_handle,
        pr_count,
        open_pr_count,
        merged_pr_count,
        closed_unmerged_pr_count,
        comment_count
      FROM github_users
      ORDER BY pr_count DESC, comment_count DESC, handle ASC
    `);
    return c.json(rows.map((row) => ({
      author: row.display_handle,
      handle: row.handle,
      cnt: Number(row.pr_count ?? 0),
      openPrCount: Number(row.open_pr_count ?? 0),
      mergedPrCount: Number(row.merged_pr_count ?? 0),
      closedUnmergedPrCount: Number(row.closed_unmerged_pr_count ?? 0),
      commentCount: Number(row.comment_count ?? 0),
      profileUrl: githubAuthorProfilePath(row.handle),
    })));
  });

  api.get('/github-users/:handle', async (c) => {
    const db = await getDb();
    const handle = normalizeGitHubHandle(c.req.param('handle'));
    if (!handle) return c.json({ error: 'User not found' }, 404);

    const user = await db.get<any>('SELECT * FROM github_users WHERE handle = ?', [handle]);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const recentPRs = await db.all<any>(`
      SELECT
        pr.number,
        pr.title,
        pr.body,
        pr.state,
        pr.created_at,
        pr.updated_at,
        COALESCE((SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number), 0) as comment_count,
        (SELECT pc.author FROM pr_comments pc WHERE pc.pr_number = pr.number ORDER BY pc.created_at DESC, pc.comment_id DESC LIMIT 1) as latest_comment_author,
        (SELECT COALESCE(pc.author_handle, LOWER(pc.author)) FROM pr_comments pc WHERE pc.pr_number = pr.number ORDER BY pc.created_at DESC, pc.comment_id DESC LIMIT 1) as latest_comment_author_handle,
        (SELECT pc.body FROM pr_comments pc WHERE pc.pr_number = pr.number ORDER BY pc.created_at DESC, pc.comment_id DESC LIMIT 1) as latest_comment_body
      FROM pull_requests pr
      WHERE COALESCE(pr.author_handle, LOWER(pr.author)) = ?
      ORDER BY pr.updated_at DESC, pr.number DESC
      LIMIT 40
    `, [handle]);

    const recentComments = await db.all<any>(`
      SELECT
        pc.comment_id,
        pc.pr_number,
        pc.author,
        COALESCE(pc.author_handle, LOWER(pc.author)) as author_handle,
        pc.body,
        pc.created_at,
        pc.updated_at,
        pr.title as pr_title
      FROM pr_comments pc
      JOIN pull_requests pr ON pr.number = pc.pr_number
      WHERE COALESCE(pc.author_handle, LOWER(pc.author)) = ?
      ORDER BY pc.created_at DESC, pc.comment_id DESC
      LIMIT 8
    `, [handle]);

    return c.json({
      handle: user.handle,
      displayHandle: user.display_handle,
      githubUrl: `https://github.com/${encodeURIComponent(user.display_handle)}`,
      stats: {
        totalPRs: Number(user.pr_count ?? 0),
        openPRs: Number(user.open_pr_count ?? 0),
        mergedPRs: Number(user.merged_pr_count ?? 0),
        closedUnmergedPRs: Number(user.closed_unmerged_pr_count ?? 0),
        comments: Number(user.comment_count ?? 0),
      },
      recentPRs: recentPRs.map((row) => ({
        number: row.number,
        title: row.title,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        bodyExcerpt: excerpt(row.body, 220),
        commentCount: Number(row.comment_count ?? 0),
        latestCommentAuthor: row.latest_comment_author ?? null,
        latestCommentAuthorHandle: normalizeGitHubHandle(row.latest_comment_author_handle ?? row.latest_comment_author),
        latestCommentAuthorProfileUrl: githubAuthorProfilePath(row.latest_comment_author_handle ?? row.latest_comment_author),
        latestCommentExcerpt: excerpt(row.latest_comment_body, 220),
        closureContext: row.state === 'open' ? null : excerpt(row.latest_comment_body || row.body, 220),
      })),
      recentComments: recentComments.map((row) => ({
        commentId: row.comment_id,
        prNumber: row.pr_number,
        prTitle: row.pr_title,
        author: row.author,
        authorHandle: normalizeGitHubHandle(row.author_handle ?? row.author),
        authorProfileUrl: githubAuthorProfilePath(row.author_handle ?? row.author),
        excerpt: excerpt(row.body, 220),
        body: row.body,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  });

  // Scoring formula explanation
  api.get('/scoring', (_c) => {
    return _c.json(scoringFormulaDescription());
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
