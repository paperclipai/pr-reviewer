import { getDb } from '../db/client';
import { CIStatus, aggregateCheckStatus } from '../github/checks';

export interface PRCandidate {
  number: number;
  title: string;
  author: string;
  greptileScore: number | null;
  ciStatus: CIStatus;
  hasConflicts: boolean;
  compositeScore: number;
  createdAt: string;
}

export interface FilterOptions {
  minScore?: number;
  ci?: 'passing' | 'failing' | 'pending';
  noConflicts?: boolean;
  limit?: number;
}

function computeCompositeScore(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean): number {
  let score = 0;

  // Greptile component: 0-50 (score 1-5 mapped to 10-50)
  if (greptileScore !== null) {
    score += greptileScore * 10;
  }

  // CI component: 0-30
  switch (ciStatus) {
    case 'passing': score += 30; break;
    case 'pending': score += 15; break;
    case 'unknown': score += 10; break;
    case 'failing': score += 0; break;
  }

  // Conflicts: +/-20
  score += hasConflicts ? -20 : 20;

  return Math.max(0, Math.min(100, score));
}

export function listCandidates(options: FilterOptions = {}): PRCandidate[] {
  const db = getDb();

  // Fetch all PRs with their best greptile score
  const rows = db.prepare(`
    SELECT
      pr.number, pr.title, pr.author, pr.mergeable, pr.mergeable_state, pr.created_at,
      (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score
    FROM pull_requests pr
    ORDER BY pr.number DESC
  `).all() as Array<{
    number: number; title: string; author: string;
    mergeable: number | null; mergeable_state: string | null;
    created_at: string; greptile_score: number | null;
  }>;

  // Fetch check runs per PR for CI status
  const checkStmt = db.prepare(`
    SELECT name, status, conclusion, updated_at FROM check_runs WHERE pr_number = ?
  `);

  let candidates: PRCandidate[] = rows.map(row => {
    const checks = checkStmt.all(row.number) as Array<{
      name: string; status: string; conclusion: string | null; updated_at: string;
    }>;

    const ciStatus = aggregateCheckStatus(checks.map(c => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      updatedAt: c.updated_at,
    })));

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

  // Apply filters
  if (options.minScore !== undefined) {
    candidates = candidates.filter(c => c.greptileScore !== null && c.greptileScore >= options.minScore!);
  }
  if (options.ci) {
    candidates = candidates.filter(c => c.ciStatus === options.ci);
  }
  if (options.noConflicts) {
    candidates = candidates.filter(c => !c.hasConflicts);
  }

  // Sort by composite score descending
  candidates.sort((a, b) => b.compositeScore - a.compositeScore);

  if (options.limit) {
    candidates = candidates.slice(0, options.limit);
  }

  return candidates;
}

export function getPRDetail(prNumber: number) {
  const db = getDb();

  const pr = db.prepare('SELECT * FROM pull_requests WHERE number = ?').get(prNumber) as any;
  if (!pr) return null;

  const scores = db.prepare('SELECT * FROM greptile_scores WHERE pr_number = ? ORDER BY created_at DESC').all(prNumber);
  const checks = db.prepare('SELECT * FROM check_runs WHERE pr_number = ?').all(prNumber);
  const reviews = db.prepare('SELECT * FROM llm_reviews WHERE pr_number = ? ORDER BY created_at DESC').all(prNumber);

  return { pr, scores, checks, reviews };
}
