// =============================================================================
// Scoring — all thresholds, weights, and scoring logic in one place.
// Change this file to tune how PRs are ranked.
// =============================================================================

// --- Types ---

export type CIStatus = 'passing' | 'failing' | 'pending' | 'unknown';

export interface AuthorStats {
  openCount: number;
  mergedCount: number;
  closedCount: number;
  totalCount: number;
  mergeRate: number;
  isFirstContribution: boolean;
}

export interface BonusSignals {
  hasTests: boolean;
  hasThinkingPath: boolean;
  hasIssueLink: boolean;
  createdAt: string;     // ISO date string
}

export interface ScoreBreakdown {
  total: number;
  greptile: { value: number; max: number; input: number | null };
  ci: { value: number; max: number; input: CIStatus };
  conflicts: { value: number; range: string; input: boolean };
  humanComments: { value: number; max: number; input: number };
  loc: { value: number; max: number; input: number; note: string };
  contributor: { value: number; range: string; input: number };
  tests: { value: number; max: number };
  thinkingPath: { value: number; max: number };
  issueLink: { value: number; max: number };
  freshness: { value: number; max: number; input: number };
}

// --- Constants ---

export const MAX_SCORE = 180;

const GREPTILE_MULTIPLIER = 8;                        // 0-40 pts (score 1-5 × 8)
const CI_SCORES: Record<CIStatus, number> = { passing: 25, pending: 12, unknown: 8, failing: 0 };
const CONFLICT_BONUS = 15;                            // +15 no conflicts, -15 conflicts
const COMMENT_SCORES = { one: 10, twoPlus: 20 };     // 0-20 pts
const LOC_BASE = 15;
const LOC_DECAY = 3;                                  // 0-15 pts, log decay

const CONTRIBUTOR_BASE = 50;
const CONTRIBUTOR_SCALE = 0.5;                        // maps 0-100 → -25 to +25

const BONUS_TESTS = 10;
const BONUS_THINKING_PATH = 10;
const BONUS_ISSUE_LINK = 10;

const FRESHNESS_TIERS = [
  { maxDays: 1,  pts: 10 },
  { maxDays: 3,  pts: 8 },
  { maxDays: 7,  pts: 5 },
  { maxDays: 14, pts: 2 },
];

// --- Detection patterns ---

export const TEST_FILE_SQL = `lower(filename) LIKE '%.test.%' OR lower(filename) LIKE '%_test.%' OR lower(filename) LIKE '%/__tests__/%' OR lower(filename) LIKE '%.spec.%' OR lower(filename) LIKE '%_spec.%'`;

export const THINKING_PATH_SQL = `lower(body) LIKE '%thinking path%'`;

export const ISSUE_LINK_SQL = `lower(body) LIKE '%closes #%' OR lower(body) LIKE '%fixes #%' OR lower(body) LIKE '%resolves #%' OR body LIKE '%/issues/%'`;

export function detectThinkingPath(body: string): boolean {
  return body.toLowerCase().includes('thinking path');
}

export function detectIssueLink(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('closes #') || lower.includes('fixes #') || lower.includes('resolves #') || body.includes('/issues/');
}

// --- Pure scoring functions ---

export function deriveCIStatus(totalChecks: number, failedChecks: number, pendingChecks: number): CIStatus {
  if (totalChecks === 0) return 'unknown';
  if (failedChecks > 0) return 'failing';
  if (pendingChecks > 0) return 'pending';
  return 'passing';
}

export function locScore(additions: number, deletions: number): number {
  const totalLoc = additions + deletions;
  if (totalLoc === 0) return LOC_BASE;
  return Math.max(0, Math.round(LOC_BASE - LOC_DECAY * Math.log10(totalLoc)));
}

/** Base score from the five core signals (0-115). */
export function computeBaseScore(
  greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean,
  humanComments: number, additions: number = 0, deletions: number = 0,
): number {
  let score = 0;
  if (greptileScore !== null) score += greptileScore * GREPTILE_MULTIPLIER;
  score += CI_SCORES[ciStatus];
  score += hasConflicts ? -CONFLICT_BONUS : CONFLICT_BONUS;
  if (humanComments >= 2) score += COMMENT_SCORES.twoPlus;
  else if (humanComments === 1) score += COMMENT_SCORES.one;
  score += locScore(additions, deletions);
  return Math.max(0, Math.min(115, score));
}

/** Contributor priority score (0-100) with detailed breakdown. */
export function computeContributorScore(stats: AuthorStats): { score: number; breakdown: Record<string, { value: number; reason: string }> } {
  const breakdown: Record<string, { value: number; reason: string }> = {};

  // First-time contributor
  if (stats.isFirstContribution) {
    breakdown.newcomer = { value: 15, reason: 'First contribution' };
  }

  // Track record (modest so it can't mask bad merge rate)
  if (stats.mergedCount >= 5) {
    breakdown.trackRecord = { value: 10, reason: `${stats.mergedCount} merged PRs — proven contributor` };
  } else if (stats.mergedCount >= 2) {
    breakdown.trackRecord = { value: 6, reason: `${stats.mergedCount} merged PRs — returning contributor` };
  } else if (stats.mergedCount === 1) {
    breakdown.trackRecord = { value: 3, reason: '1 merged PR — has landed work before' };
  } else {
    breakdown.trackRecord = { value: 0, reason: 'No merged PRs yet' };
  }

  // Merge rate: smooth gradient
  const decided = stats.mergedCount + stats.closedCount;
  if (decided >= 2) {
    const pct = Math.round(stats.mergeRate * 100);
    if (stats.mergeRate >= 0.8) {
      breakdown.mergeRate = { value: 10, reason: `${pct}% merge rate — high quality` };
    } else if (stats.mergeRate >= 0.6) {
      breakdown.mergeRate = { value: 5, reason: `${pct}% merge rate — above average` };
    } else if (stats.mergeRate >= 0.4) {
      breakdown.mergeRate = { value: 0, reason: `${pct}% merge rate` };
    } else if (stats.mergeRate >= 0.2) {
      breakdown.mergeRate = { value: -15, reason: `${pct}% merge rate — below average` };
    } else {
      breakdown.mergeRate = { value: -30, reason: `${pct}% merge rate — very few PRs merged` };
    }
  } else {
    breakdown.mergeRate = { value: 0, reason: 'Not enough history to judge' };
  }

  // Open PR load
  if (stats.openCount >= 5) {
    breakdown.openLoad = { value: 10, reason: `${stats.openCount} open PRs — heavy contributor, needs review bandwidth` };
  } else if (stats.openCount >= 3) {
    breakdown.openLoad = { value: 6, reason: `${stats.openCount} open PRs — active contributor` };
  } else if (stats.openCount >= 2) {
    breakdown.openLoad = { value: 3, reason: `${stats.openCount} open PRs` };
  } else {
    breakdown.openLoad = { value: 0, reason: '1 open PR' };
  }

  const total = CONTRIBUTOR_BASE + Object.values(breakdown).reduce((sum, b) => sum + b.value, 0);
  return { score: Math.max(0, Math.min(100, total)), breakdown };
}

/** Map contributor score (0-100) to composite points (-25 to +25), centered at 50. */
export function contributorPts(contributorScore: number): number {
  return Math.round((contributorScore - CONTRIBUTOR_BASE) * CONTRIBUTOR_SCALE);
}

export function testPts(hasTests: boolean): number {
  return hasTests ? BONUS_TESTS : 0;
}

export function thinkingPathPts(hasThinkingPath: boolean): number {
  return hasThinkingPath ? BONUS_THINKING_PATH : 0;
}

export function issueLinkPts(hasIssueLink: boolean): number {
  return hasIssueLink ? BONUS_ISSUE_LINK : 0;
}

export function freshnessPts(createdAt: string, now: number = Date.now()): { pts: number; ageDays: number } {
  const createdMs = new Date(createdAt.endsWith('Z') ? createdAt : createdAt + 'Z').getTime();
  const ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);
  for (const tier of FRESHNESS_TIERS) {
    if (ageDays < tier.maxDays) return { pts: tier.pts, ageDays };
  }
  return { pts: 0, ageDays };
}

/** Compute full composite score from base + all bonus signals. */
export function computeCompositeScore(baseScore: number, extras: {
  contributorPts: number; testPts: number; thinkingPathPts: number;
  issueLinkPts: number; freshnessPts: number;
}): number {
  return Math.max(0, Math.min(MAX_SCORE,
    baseScore + extras.contributorPts + extras.testPts +
    extras.thinkingPathPts + extras.issueLinkPts + extras.freshnessPts
  ));
}

/** Full breakdown for display (list tooltip and detail page). */
export function computeFullBreakdown(
  greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean,
  humanComments: number, additions: number, deletions: number,
  contribPts: number, contribRaw: number,
  tPts: number, tpPts: number, ilPts: number, fPts: number, ageDays: number,
): ScoreBreakdown {
  const greptile = greptileScore !== null ? greptileScore * GREPTILE_MULTIPLIER : 0;
  const ci = CI_SCORES[ciStatus];
  const conflicts = hasConflicts ? -CONFLICT_BONUS : CONFLICT_BONUS;
  let comments = 0;
  if (humanComments >= 2) comments = COMMENT_SCORES.twoPlus;
  else if (humanComments === 1) comments = COMMENT_SCORES.one;
  const loc = locScore(additions, deletions);
  const baseTotal = Math.max(0, Math.min(115, greptile + ci + conflicts + comments + loc));

  return {
    total: Math.max(0, Math.min(MAX_SCORE, baseTotal + contribPts + tPts + tpPts + ilPts + fPts)),
    greptile: { value: greptile, max: 40, input: greptileScore },
    ci: { value: ci, max: 25, input: ciStatus },
    conflicts: { value: conflicts, range: '-15 to +15', input: hasConflicts },
    humanComments: { value: comments, max: 20, input: humanComments },
    loc: { value: loc, max: 15, input: additions + deletions, note: 'Fewer changes = higher score' },
    contributor: { value: contribPts, range: '-25 to +25', input: contribRaw },
    tests: { value: tPts, max: 10 },
    thinkingPath: { value: tpPts, max: 10 },
    issueLink: { value: ilPts, max: 10 },
    freshness: { value: fPts, max: 10, input: Math.round(ageDays) },
  };
}

/** Static description of the scoring formula for the /scoring endpoint. */
export function scoringFormulaDescription() {
  return {
    description: `Composite score (0-${MAX_SCORE}) computed from ten signals`,
    formula: {
      greptile: { weight: '0-40', calculation: `greptileScore * ${GREPTILE_MULTIPLIER}`, note: 'Greptile bot confidence score (1-5) from PR comments' },
      ci: { weight: '0-25', values: CI_SCORES },
      conflicts: { weight: '-15 to +15', values: { noConflicts: CONFLICT_BONUS, hasConflicts: -CONFLICT_BONUS } },
      humanComments: { weight: '0-20', values: { '0': 0, '1': COMMENT_SCORES.one, '2+': COMMENT_SCORES.twoPlus }, note: 'Excludes bot comments (authors matching *[bot])' },
      loc: { weight: '0-15', calculation: `max(0, round(${LOC_BASE} - ${LOC_DECAY} * log10(totalLoc)))`, note: 'Fewer lines changed = higher score' },
      contributor: { weight: '-25 to +25', calculation: `round((contributorScore - ${CONTRIBUTOR_BASE}) * ${CONTRIBUTOR_SCALE})`, note: 'Contributor priority (0-100) centered at 50' },
      tests: { weight: `0-${BONUS_TESTS}`, note: 'PRs that include test files (.test., _test., __tests__/, .spec., _spec.)' },
      thinkingPath: { weight: `0-${BONUS_THINKING_PATH}`, note: 'PRs with "Thinking Path" in description' },
      issueLink: { weight: `0-${BONUS_ISSUE_LINK}`, note: 'PRs linking to a GitHub issue (closes/fixes/resolves # or /issues/ URL)' },
      freshness: { weight: '0-10', tiers: FRESHNESS_TIERS, note: 'Newer PRs score higher' },
    },
    maxScore: MAX_SCORE,
    minScore: 0,
  };
}
