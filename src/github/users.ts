import type { DbClient } from '../db/types';

export function normalizeGitHubHandle(input: string | null | undefined): string {
  return String(input ?? '').trim().toLowerCase();
}

export function githubAuthorProfilePath(handle: string | null | undefined): string | null {
  const normalized = normalizeGitHubHandle(handle);
  if (!normalized) return null;
  return `#/authors/${encodeURIComponent(normalized)}`;
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
