import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getSchema } from '../src/db/bootstrap';
import { SqliteClient } from '../src/db/sqlite';
import { rebuildGitHubUsers } from '../src/github/users';

describe('contributor refresh write usage', () => {
  let db: SqliteClient;
  const changes = async () => (await db.get<{ n: number }>('SELECT total_changes() AS n'))!.n;

  beforeEach(async () => {
    db = new SqliteClient(':memory:');
    // Legacy databases have nullable handles. Exercise the backfill as well as
    // the normal sync path, which inserts already-normalized handles.
    await db.exec(getSchema().replaceAll('author_handle TEXT NOT NULL', 'author_handle TEXT'));
    await db.run(`INSERT INTO pull_requests
      (number, title, author, author_handle, head_sha, created_at, updated_at)
      VALUES (1, 'First PR', 'Alice', ' ALICE ', 'sha1', '2026-01-01', '2026-01-01'),
             (2, 'Second PR', 'Bob', '', 'sha2', '2026-01-01', '2026-01-01')`);
    await db.run(`INSERT INTO pr_comments
      (comment_id, pr_number, author, author_handle, body, created_at, updated_at)
      VALUES (10, 1, 'Reviewer', NULL, 'Review', '2026-01-01', '2026-01-01'),
             (11, 1, 'Alice', 'alice', 'Reply', '2026-01-01', '2026-01-01')`);
  });

  afterEach(async () => { await db.close(); });

  test('backfills missing/unnormalized handles and writes zero rows on an unchanged refresh', async () => {
    await rebuildGitHubUsers(db);
    expect(await db.all('SELECT author_handle FROM pull_requests ORDER BY number'))
      .toEqual([{ author_handle: 'alice' }, { author_handle: 'bob' }]);
    expect(await db.get('SELECT author_handle FROM pr_comments WHERE comment_id = 10'))
      .toEqual({ author_handle: 'reviewer' });
    await db.run("UPDATE github_users SET created_at = '2020-01-01', updated_at = '2020-02-01'");
    const before = await changes();
    const users = await db.all('SELECT * FROM github_users ORDER BY handle');

    await rebuildGitHubUsers(db);

    expect(await changes() - before).toBe(0);
    expect(await db.all('SELECT * FROM github_users ORDER BY handle')).toEqual(users);
  });

  test('updates only affected summaries, preserving their creation dates', async () => {
    await rebuildGitHubUsers(db);
    await db.run("UPDATE github_users SET created_at = '2020-01-01', updated_at = '2020-02-01'");
    await db.run("UPDATE pull_requests SET state = 'merged' WHERE number = 1");
    await db.run(`INSERT INTO pr_comments
      (comment_id, pr_number, author, author_handle, body, created_at, updated_at)
      VALUES (12, 2, 'Bob', 'bob', 'New comment', '2026-02-01', '2026-02-01')`);
    const before = await changes();

    await rebuildGitHubUsers(db);

    expect(await changes() - before).toBe(2);
    expect(await db.get("SELECT * FROM github_users WHERE handle = 'alice'"))
      .toMatchObject({ merged_pr_count: 1, open_pr_count: 0, created_at: '2020-01-01' });
    expect(await db.get("SELECT * FROM github_users WHERE handle = 'bob'"))
      .toMatchObject({ comment_count: 1, latest_comment_id: 12, created_at: '2020-01-01' });
    expect(await db.get("SELECT updated_at FROM github_users WHERE handle = 'reviewer'"))
      .toEqual({ updated_at: '2020-02-01' });
  });

  test('removes only contributors with no remaining PRs or comments', async () => {
    await rebuildGitHubUsers(db);
    await db.run('DELETE FROM pr_comments WHERE comment_id = 10');
    const before = await changes();
    await rebuildGitHubUsers(db);
    expect(await changes() - before).toBe(1);
    expect(await db.all('SELECT handle FROM github_users ORDER BY handle'))
      .toEqual([{ handle: 'alice' }, { handle: 'bob' }]);
  });

  test('keeps existing summaries when the aggregate write fails', async () => {
    await rebuildGitHubUsers(db);
    const users = await db.all('SELECT * FROM github_users ORDER BY handle');
    const run = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO github_users')) throw new Error('D1 write quota exceeded');
      return run(sql, params);
    });

    await expect(rebuildGitHubUsers(db)).rejects.toThrow('D1 write quota exceeded');
    expect(await db.all('SELECT * FROM github_users ORDER BY handle')).toEqual(users);
  });
});
