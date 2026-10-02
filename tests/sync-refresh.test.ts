import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { initializeDb } from '../src/db/bootstrap';
import { SqliteClient } from '../src/db/sqlite';
import { beginPRRefresh, finishPRRefresh, pendingPRs, refreshPendingUsers } from '../src/github/sync-refresh';
import { rebuildGitHubUsers } from '../src/github/users';

describe('durable incremental contributor refresh', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = await initializeDb(new SqliteClient(':memory:'));
    await db.run(`INSERT INTO pull_requests (number,title,author,author_handle,head_sha,created_at,updated_at)
      VALUES (1,'One','Alice','alice','a','2026-01-01','2026-01-01'),
             (2,'Two','Bob','bob','b','2026-01-01','2026-01-01')`);
    await db.run(`INSERT INTO pr_comments(comment_id,pr_number,author,author_handle,body,created_at,updated_at)
      VALUES (11,1,'Reviewer','reviewer','Review','2026-01-01','2026-01-01')`);
    await refreshPendingUsers(db);
  });
  afterEach(async () => { await db.close(); });
  const summaries = () => db.all(`SELECT handle,display_handle,pr_count,open_pr_count,merged_pr_count,
    closed_unmerged_pr_count,comment_count,latest_pr_number,latest_pr_at,latest_comment_id,latest_comment_at
    FROM github_users ORDER BY handle`);

  test('refreshes old/new PR and comment authors with the same result as a full rebuild', async () => {
    const untouched = await db.get("SELECT * FROM github_users WHERE handle='bob'");
    await db.run("UPDATE github_users SET created_at='2020-01-01' WHERE handle='alice'");
    await beginPRRefresh(db, 1, ['NewAlice', 'NewReviewer'], 'run-1');
    await db.run("UPDATE pull_requests SET author='NewAlice', author_handle='newalice',state='merged',updated_at='2026-02-01' WHERE number=1");
    await db.run("UPDATE pr_comments SET author='NewReviewer',author_handle='newreviewer',updated_at='2026-02-02' WHERE comment_id=11");
    await finishPRRefresh(db, 1, 'run-1');
    await refreshPendingUsers(db);
    const incremental = await summaries();
    expect(incremental.map((row: any) => row.handle)).toEqual(['bob', 'newalice', 'newreviewer']);
    expect(await db.get("SELECT * FROM github_users WHERE handle='bob'")).toEqual(untouched);
    expect(await pendingPRs(db)).toEqual(new Set());
    await rebuildGitHubUsers(db);
    expect(await summaries()).toEqual(incremental);
  });

  test('keeps pending work through a failed aggregate refresh and retries idempotently', async () => {
    await beginPRRefresh(db, 1, ['Alice'], 'run-1');
    await db.run("UPDATE pull_requests SET state='closed' WHERE number=1");
    await finishPRRefresh(db, 1, 'run-1');
    const run = db.run.bind(db);
    const spy = vi.spyOn(db, 'run').mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO github_users')) throw new Error('temporary failure');
      return run(sql, params);
    });
    await expect(refreshPendingUsers(db)).rejects.toThrow('temporary failure');
    expect(await db.all("SELECT key FROM sync_state WHERE key >= 'pending_user:' AND key < 'pending_user;'"))
      .toEqual([{ key: 'pending_user:alice' }, { key: 'pending_user:reviewer' }]);
    spy.mockRestore();
    await refreshPendingUsers(db);
    expect(await db.get("SELECT closed_unmerged_pr_count FROM github_users WHERE handle='alice'"))
      .toEqual({ closed_unmerged_pr_count: 1 });
    expect(await db.all("SELECT key FROM sync_state WHERE key >= 'pending_user:' AND key < 'pending_user;'"))
      .toEqual([]);
    const before = await summaries();
    await refreshPendingUsers(db);
    expect(await summaries()).toEqual(before);
  });

  test('an unchanged refresh reads only markers and never scans or updates source tables', async () => {
    const get = vi.spyOn(db, 'get');
    const all = vi.spyOn(db, 'all');
    const run = vi.spyOn(db, 'run');
    await refreshPendingUsers(db);
    expect(get).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    expect([...get.mock.calls, ...all.mock.calls].every(([sql]) => sql.includes('sync_state'))).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  test('retains a newer enqueue when finishing an older PR or aggregate refresh', async () => {
    await beginPRRefresh(db, 1, ['Alice'], 'old');
    await beginPRRefresh(db, 1, ['Alice'], 'new');
    await finishPRRefresh(db, 1, 'old');
    expect(await pendingPRs(db)).toEqual(new Set([1]));
    const run = db.run.bind(db);
    let advanced = false;
    const spy = vi.spyOn(db, 'run').mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO github_users') && !advanced) {
        advanced = true;
        await run("UPDATE sync_state SET value='newer' WHERE key='pending_user:alice'");
      }
      return run(sql, params);
    });
    await refreshPendingUsers(db);
    spy.mockRestore();
    expect(await db.get("SELECT value FROM sync_state WHERE key='pending_user:alice'"))
      .toEqual({ value: 'newer' });
  });

  test('chunks a large pending set below the D1 bound-parameter limit', async () => {
    for (let i = 0; i < 105; i++) {
      await db.run('INSERT INTO sync_state(key,value) VALUES (?,?)', [`pending_user:missing${i}`, 'run']);
    }
    const run = vi.spyOn(db, 'run');
    await refreshPendingUsers(db);
    expect(run.mock.calls.every(([, params]) => (params?.length ?? 0) <= 80)).toBe(true);
    expect(await db.all("SELECT key FROM sync_state WHERE key >= 'pending_user:' AND key < 'pending_user;'"))
      .toEqual([]);
  });
});
