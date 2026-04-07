import type { DbClient } from '../db/types';

export function normalizeGitHubHandle(input: string | null | undefined): string {
  return String(input ?? '').trim().toLowerCase();
}

export type GitHubLeaderboardSort =
  | 'mergeScore'
  | 'totalPRs'
  | 'openPRs'
  | 'mergedPRs'
  | 'closedUnmergedPRs'
  | 'comments';

export interface GitHubUserSummary {
  author: string;
  handle: string;
  cnt: number;
  totalPRs: number;
  openPRs: number;
  openPrCount: number;
  mergedPRs: number;
  mergedPrCount: number;
  closedUnmergedPRs: number;
  closedUnmergedPrCount: number;
  commentCount: number;
  mergeRate: number;
  mergeScore: number;
  profileUrl: string | null;
}

const WILSON_Z = 1.96;

export function githubAuthorProfilePath(handle: string | null | undefined): string | null {
  const normalized = normalizeGitHubHandle(handle);
  if (!normalized) return null;
  return `/#/authors/${encodeURIComponent(normalized)}`;
}

function toCount(input: unknown): number {
  const value = Number(input ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computeMergeRate(mergedPRs: number, totalPRs: number): number {
  if (totalPRs <= 0 || mergedPRs <= 0) return 0;
  return roundPct((mergedPRs / totalPRs) * 100);
}

export function computeMergeScore(mergedPRs: number, totalPRs: number): number {
  if (totalPRs <= 0 || mergedPRs <= 0) return 0;
  const p = mergedPRs / totalPRs;
  const z2 = WILSON_Z * WILSON_Z;
  const denominator = 1 + z2 / totalPRs;
  const center = p + z2 / (2 * totalPRs);
  const margin = WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * totalPRs)) / totalPRs);
  return roundPct((Math.max(0, center - margin) / denominator) * 100);
}

export function mapGitHubUserSummary(row: any): GitHubUserSummary {
  const totalPRs = toCount(row.pr_count);
  const openPRs = toCount(row.open_pr_count);
  const mergedPRs = toCount(row.merged_pr_count);
  const closedUnmergedPRs = toCount(row.closed_unmerged_pr_count);
  const commentCount = toCount(row.comment_count);
  const handle = normalizeGitHubHandle(row.handle);

  return {
    author: row.display_handle,
    handle,
    cnt: totalPRs,
    totalPRs,
    openPRs,
    openPrCount: openPRs,
    mergedPRs,
    mergedPrCount: mergedPRs,
    closedUnmergedPRs,
    closedUnmergedPrCount: closedUnmergedPRs,
    commentCount,
    mergeRate: computeMergeRate(mergedPRs, totalPRs),
    mergeScore: computeMergeScore(mergedPRs, totalPRs),
    profileUrl: githubAuthorProfilePath(handle),
  };
}

function compareStringsAscending(a: string, b: string): number {
  return a.localeCompare(b);
}

export function sortGitHubUserSummaries(
  users: GitHubUserSummary[],
  sort: GitHubLeaderboardSort,
): GitHubUserSummary[] {
  const copy = [...users];
  copy.sort((a, b) => {
    switch (sort) {
      case 'totalPRs':
        return (
          b.totalPRs - a.totalPRs ||
          b.mergeScore - a.mergeScore ||
          b.mergedPRs - a.mergedPRs ||
          compareStringsAscending(a.handle, b.handle)
        );
      case 'openPRs':
        return (
          b.openPRs - a.openPRs ||
          b.totalPRs - a.totalPRs ||
          b.mergeScore - a.mergeScore ||
          compareStringsAscending(a.handle, b.handle)
        );
      case 'mergedPRs':
        return (
          b.mergedPRs - a.mergedPRs ||
          b.mergeScore - a.mergeScore ||
          b.totalPRs - a.totalPRs ||
          compareStringsAscending(a.handle, b.handle)
        );
      case 'closedUnmergedPRs':
        return (
          b.closedUnmergedPRs - a.closedUnmergedPRs ||
          b.totalPRs - a.totalPRs ||
          b.mergeScore - a.mergeScore ||
          compareStringsAscending(a.handle, b.handle)
        );
      case 'comments':
        return (
          b.commentCount - a.commentCount ||
          b.totalPRs - a.totalPRs ||
          b.mergeScore - a.mergeScore ||
          compareStringsAscending(a.handle, b.handle)
        );
      case 'mergeScore':
      default:
        return (
          b.mergeScore - a.mergeScore ||
          b.mergedPRs - a.mergedPRs ||
          b.totalPRs - a.totalPRs ||
          compareStringsAscending(a.handle, b.handle)
        );
    }
  });
  return copy;
}

export function parseGitHubLeaderboardSort(input: string | null | undefined): GitHubLeaderboardSort {
  switch (input) {
    case 'totalPRs':
    case 'openPRs':
    case 'mergedPRs':
    case 'closedUnmergedPRs':
    case 'comments':
    case 'mergeScore':
      return input;
    default:
      return 'mergeScore';
  }
}

export async function rebuildGitHubUsers(db: DbClient): Promise<void> {
  await db.run(`
    UPDATE pull_requests
    SET author_handle = LOWER(TRIM(COALESCE(NULLIF(author_handle, ''), author)))
    WHERE COALESCE(author, '') != ''
  `);
  await db.run(`
    UPDATE pr_comments
    SET author_handle = LOWER(TRIM(COALESCE(NULLIF(author_handle, ''), author)))
    WHERE COALESCE(author, '') != ''
  `);

  await db.run(`DELETE FROM github_users`);
  await db.run(`
    INSERT INTO github_users (
      handle,
      display_handle,
      pr_count,
      open_pr_count,
      merged_pr_count,
      closed_unmerged_pr_count,
      comment_count,
      latest_pr_number,
      latest_pr_at,
      latest_comment_id,
      latest_comment_at,
      created_at,
      updated_at
    )
    WITH author_handles AS (
      SELECT author_handle AS handle
      FROM pull_requests
      WHERE COALESCE(author_handle, '') != ''
      UNION
      SELECT author_handle AS handle
      FROM pr_comments
      WHERE COALESCE(author_handle, '') != ''
    )
    SELECT
      ah.handle,
      COALESCE(
        (
          SELECT pr.author
          FROM pull_requests pr
          WHERE pr.author_handle = ah.handle
          ORDER BY pr.updated_at DESC, pr.number DESC
          LIMIT 1
        ),
        (
          SELECT pc.author
          FROM pr_comments pc
          WHERE pc.author_handle = ah.handle
          ORDER BY pc.updated_at DESC, pc.comment_id DESC
          LIMIT 1
        ),
        ah.handle
      ) AS display_handle,
      COALESCE((SELECT COUNT(*) FROM pull_requests pr WHERE pr.author_handle = ah.handle), 0) AS pr_count,
      COALESCE((SELECT COUNT(*) FROM pull_requests pr WHERE pr.author_handle = ah.handle AND pr.state = 'open'), 0) AS open_pr_count,
      COALESCE((SELECT COUNT(*) FROM pull_requests pr WHERE pr.author_handle = ah.handle AND pr.state = 'merged'), 0) AS merged_pr_count,
      COALESCE((SELECT COUNT(*) FROM pull_requests pr WHERE pr.author_handle = ah.handle AND pr.state = 'closed'), 0) AS closed_unmerged_pr_count,
      COALESCE((SELECT COUNT(*) FROM pr_comments pc WHERE pc.author_handle = ah.handle), 0) AS comment_count,
      (
        SELECT pr.number
        FROM pull_requests pr
        WHERE pr.author_handle = ah.handle
        ORDER BY pr.updated_at DESC, pr.number DESC
        LIMIT 1
      ) AS latest_pr_number,
      (
        SELECT pr.updated_at
        FROM pull_requests pr
        WHERE pr.author_handle = ah.handle
        ORDER BY pr.updated_at DESC, pr.number DESC
        LIMIT 1
      ) AS latest_pr_at,
      (
        SELECT pc.comment_id
        FROM pr_comments pc
        WHERE pc.author_handle = ah.handle
        ORDER BY pc.created_at DESC, pc.comment_id DESC
        LIMIT 1
      ) AS latest_comment_id,
      (
        SELECT pc.created_at
        FROM pr_comments pc
        WHERE pc.author_handle = ah.handle
        ORDER BY pc.created_at DESC, pc.comment_id DESC
        LIMIT 1
      ) AS latest_comment_at,
      datetime('now'),
      datetime('now')
    FROM author_handles ah
    ORDER BY ah.handle
  `);
}
