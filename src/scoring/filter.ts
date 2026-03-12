import { getDb } from '../db/client';
import { CIStatus } from '../github/checks';

export interface PRCandidate {
  number: number;
  title: string;
  author: string;
  greptileScore: number | null;
  ciStatus: CIStatus;
  hasConflicts: boolean;
  humanComments: number;
  compositeScore: number;
  createdAt: string;
}

export interface FilterOptions {
  minScore?: number;
  ci?: 'passing' | 'failing' | 'pending';
  noConflicts?: boolean;
  limit?: number;
}

function computeCompositeScore(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean, humanComments: number): number {
  let score = 0;

  // Greptile: 0-40 (score 1-5 mapped to 8-40)
  if (greptileScore !== null) {
    score += greptileScore * 8;
  }

  // CI: 0-25
  switch (ciStatus) {
    case 'passing': score += 25; break;
    case 'pending': score += 12; break;
    case 'unknown': score += 8; break;
    case 'failing': score += 0; break;
  }

  // Conflicts: +/-15
  score += hasConflicts ? -15 : 15;

  // Human comments: 0-20 (1 comment = 10, 2+ = 20)
  if (humanComments >= 2) score += 20;
  else if (humanComments === 1) score += 10;

  return Math.max(0, Math.min(100, score));
}

function deriveCIStatus(totalChecks: number, failedChecks: number, pendingChecks: number): CIStatus {
  if (totalChecks === 0) return 'unknown';
  if (failedChecks > 0) return 'failing';
  if (pendingChecks > 0) return 'pending';
  return 'passing';
}

export async function listCandidates(options: FilterOptions = {}): Promise<PRCandidate[]> {
  const db = await getDb();

  const rows = await db.all<{
    number: number; title: string; author: string;
    mergeable: number | null; mergeable_state: string | null;
    created_at: string; greptile_score: number | null;
    total_checks: number; failed_checks: number; pending_checks: number;
    human_comments: number;
  }>(`
    SELECT
      pr.number, pr.title, pr.author, pr.mergeable, pr.mergeable_state, pr.created_at,
      (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks,
      (SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number AND pc.author NOT LIKE '%[bot]') as human_comments
    FROM pull_requests pr
    ORDER BY pr.number DESC
  `);

  let candidates: PRCandidate[] = rows.map(row => {
    const ciStatus = deriveCIStatus(row.total_checks, row.failed_checks, row.pending_checks);
    const hasConflicts = row.mergeable === 0 || row.mergeable_state === 'dirty';

    return {
      number: row.number,
      title: row.title,
      author: row.author,
      greptileScore: row.greptile_score,
      ciStatus,
      hasConflicts,
      humanComments: row.human_comments,
      compositeScore: computeCompositeScore(row.greptile_score, ciStatus, hasConflicts, row.human_comments),
      createdAt: row.created_at,
    };
  });

  if (options.minScore !== undefined) {
    candidates = candidates.filter(c => c.greptileScore !== null && c.greptileScore >= options.minScore!);
  }
  if (options.ci) {
    candidates = candidates.filter(c => c.ciStatus === options.ci);
  }
  if (options.noConflicts) {
    candidates = candidates.filter(c => !c.hasConflicts);
  }

  candidates.sort((a, b) => b.compositeScore - a.compositeScore);

  if (options.limit) {
    candidates = candidates.slice(0, options.limit);
  }

  return candidates;
}

export async function getPRDetail(prNumber: number) {
  const db = await getDb();

  const pr = await db.get('SELECT * FROM pull_requests WHERE number = ?', [prNumber]);
  if (!pr) return null;

  const scores = await db.all('SELECT * FROM greptile_scores WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);
  const checks = await db.all('SELECT * FROM check_runs WHERE pr_number = ?', [prNumber]);
  const reviews = await db.all('SELECT * FROM llm_reviews WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);

  return { pr, scores, checks, reviews };
}
