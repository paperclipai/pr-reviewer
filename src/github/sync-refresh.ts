import type { DbClient } from '../db/types';
import { normalizeGitHubHandle, rebuildGitHubUsers } from './users';

const PR_PREFIX = 'pending_pr:';
const USER_PREFIX = 'pending_user:';

export async function pendingPRs(db: DbClient): Promise<Set<number>> {
  const rows = await db.all<{ key: string }>(
    "SELECT key FROM sync_state WHERE key >= 'pending_pr:' AND key < 'pending_pr;'",
  );
  return new Set(rows.map(row => Number(row.key.slice(PR_PREFIX.length))));
}

// The REST DbClient is sequential, NOT transactional. Persist retry information
// before any source writes; a failed prefix must prevent the source mutation.
export async function beginPRRefresh(db: DbClient, number: number, authors: string[], token: string): Promise<void> {
  await db.run('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)', [PR_PREFIX + number, token]);
  const previous = await db.all<{ handle: string }>(`
    SELECT author_handle AS handle FROM pull_requests WHERE number = ?
    UNION SELECT author_handle FROM pr_comments WHERE pr_number = ?
  `, [number, number]);
  const handles = new Set([...previous.map(row => row.handle), ...authors].map(normalizeGitHubHandle).filter(Boolean));
  for (const handle of handles) {
    await db.run(`INSERT INTO sync_state(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE sync_state.value IS NOT excluded.value`, [USER_PREFIX + handle, token]);
  }
}

export async function finishPRRefresh(db: DbClient, number: number, token: string): Promise<void> {
  await db.run('DELETE FROM sync_state WHERE key = ? AND value = ?', [PR_PREFIX + number, token]);
}

export async function refreshPendingUsers(db: DbClient): Promise<void> {
  const initialized = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'incremental_users_version'");
  // One initial repair also covers old syncs that wrote source rows and then
  // failed their aggregate rebuild. No schema/index migration is needed.
  const pending = await db.all<{ key: string; value: string }>(
    "SELECT key, value FROM sync_state WHERE key >= 'pending_user:' AND key < 'pending_user;'",
  );
  if (initialized?.value !== '1') {
    await rebuildGitHubUsers(db);
    await db.run("INSERT INTO sync_state(key, value) VALUES ('incremental_users_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  } else {
    await rebuildGitHubUsers(db, pending.map(row => row.key.slice(USER_PREFIX.length)));
  }
  // Compare tokens so a newer enqueue cannot be erased by an older refresh.
  // Never clear the queue before the aggregate write succeeds.
  for (const row of pending) {
    await db.run('DELETE FROM sync_state WHERE key = ? AND value = ?', [row.key, row.value]);
  }
}
