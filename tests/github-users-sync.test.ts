import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { initializeDb } from '../src/db/bootstrap';
import { SqliteClient } from '../src/db/sqlite';
import type { DbClient } from '../src/db/types';
import { createApp } from '../src/web/app';

const mockState = vi.hoisted(() => {
  const pullsList = Symbol('pulls.list');
  const listComments = Symbol('issues.listComments');
  const listFiles = Symbol('pulls.listFiles');
  const state: {
    db: DbClient | null;
    pullsList: symbol;
    listComments: symbol;
    listFiles: symbol;
    getDb: ReturnType<typeof vi.fn>;
    octokit: any;
  } = {
    db: null,
    pullsList,
    listComments,
    listFiles,
    getDb: vi.fn(),
    octokit: {
      paginate: vi.fn(),
      rest: {
        pulls: {
          list: pullsList as any,
          get: vi.fn(),
          listFiles: listFiles as any,
        },
        issues: {
          listComments: listComments as any,
        },
        checks: {
          listForRef: vi.fn(),
        },
        search: {
          issuesAndPullRequests: vi.fn(),
        },
      },
    },
  };
  state.getDb.mockImplementation(async () => state.db);
  return state;
});

vi.mock('../src/db/client', () => ({
  getDb: mockState.getDb,
}));

vi.mock('../src/github/api', () => ({
  getOctokit: () => mockState.octokit,
  REPO_OWNER: 'paperclipai',
  REPO_NAME: 'paperclip',
}));

import { syncPullRequests } from '../src/github/sync';

describe('syncPullRequests github users', () => {
  let tempDir: string;
  let db: DbClient;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reviewer-sync-'));
    db = await initializeDb(new SqliteClient(path.join(tempDir, 'test.sqlite')));
    mockState.db = db;

    mockState.getDb.mockClear();
    mockState.octokit.paginate.mockReset();
    mockState.octokit.rest.pulls.get.mockReset();
    mockState.octokit.rest.checks.listForRef.mockReset();
    mockState.octokit.rest.search.issuesAndPullRequests.mockReset();

    await db.run(`
      INSERT INTO pull_requests (number, title, body, author, author_handle, head_sha, mergeable, mergeable_state, state, labels_json, additions, deletions, changed_files, created_at, updated_at, fetched_at)
      VALUES (3, 'Old PR', 'Old body', 'Alice', 'alice', 'sha-old', 1, 'clean', 'open', '[]', 1, 1, 1, '2026-03-31T10:00:00Z', '2026-03-31T10:00:00Z', '2026-03-31T10:00:00Z')
    `);
    await db.run(`
      INSERT INTO pr_comments (comment_id, pr_number, author, author_handle, body, created_at, updated_at)
      VALUES (301, 3, 'Alice', 'alice', 'Previous discussion', '2026-03-31T11:00:00Z', '2026-03-31T11:00:00Z')
    `);

    const openPRs = [
      {
        number: 1,
        title: 'New Alice PR',
        body: 'Implements the author page',
        user: { login: 'Alice' },
        head: { sha: 'sha-1' },
        labels: [],
        created_at: '2026-04-01T10:00:00Z',
        updated_at: '2026-04-01T10:00:00Z',
      },
      {
        number: 2,
        title: 'Bob PR',
        body: 'Improves sync logic',
        user: { login: 'Bob' },
        head: { sha: 'sha-2' },
        labels: [],
        created_at: '2026-04-01T11:00:00Z',
        updated_at: '2026-04-01T11:00:00Z',
      },
    ];

    const commentsByIssue: Record<number, any[]> = {
      1: [
        {
          id: 201,
          user: { login: 'Alice' },
          body: 'Following up on review feedback.',
          created_at: '2026-04-01T12:00:00Z',
          updated_at: '2026-04-01T12:00:00Z',
        },
        {
          id: 202,
          user: { login: 'Reviewer' },
          body: 'Looks good now.',
          created_at: '2026-04-01T12:30:00Z',
          updated_at: '2026-04-01T12:30:00Z',
        },
      ],
      2: [
        {
          id: 203,
          user: { login: 'Bob' },
          body: 'Ready for merge.',
          created_at: '2026-04-01T12:15:00Z',
          updated_at: '2026-04-01T12:15:00Z',
        },
      ],
    };

    const filesByPr: Record<number, any[]> = {
      1: [{ filename: 'src/web/routes.ts', status: 'modified' }],
      2: [{ filename: 'src/github/sync.ts', status: 'modified' }],
    };

    mockState.octokit.paginate.mockImplementation(async (endpoint: unknown, params: any) => {
      if (endpoint === mockState.pullsList) {
        if (params.state === 'closed') return [];
        return openPRs;
      }
      if (endpoint === mockState.listComments) return commentsByIssue[params.issue_number] ?? [];
      if (endpoint === mockState.listFiles) return filesByPr[params.pull_number] ?? [];
      throw new Error('Unexpected paginate call');
    });

    mockState.octokit.rest.pulls.get.mockImplementation(async ({ pull_number }: { pull_number: number }) => {
      if (pull_number === 3) {
        return { data: { state: 'closed', merged: true } };
      }
      return {
        data: {
          state: 'open',
          mergeable: true,
          mergeable_state: 'clean',
          additions: pull_number === 1 ? 25 : 12,
          deletions: pull_number === 1 ? 5 : 4,
          changed_files: pull_number === 1 ? 3 : 2,
        },
      };
    });

    mockState.octokit.rest.checks.listForRef.mockResolvedValue({ data: { check_runs: [] } });
    mockState.octokit.rest.search.issuesAndPullRequests
      .mockResolvedValueOnce({ data: { total_count: 1 } })
      .mockResolvedValueOnce({ data: { total_count: 1 } });
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    mockState.db = null;
  });

  test('rebuilds github user aggregates from synced PRs and comments', async () => {
    await syncPullRequests();

    const alice = await db.get<any>('SELECT * FROM github_users WHERE handle = ?', ['alice']);
    const bob = await db.get<any>('SELECT * FROM github_users WHERE handle = ?', ['bob']);
    const reviewer = await db.get<any>('SELECT * FROM github_users WHERE handle = ?', ['reviewer']);
    const stalePr = await db.get<any>('SELECT state FROM pull_requests WHERE number = ?', [3]);
    const syncedComment = await db.get<any>('SELECT author_handle FROM pr_comments WHERE comment_id = ?', [201]);

    expect(alice).toMatchObject({
      display_handle: 'Alice',
      pr_count: 2,
      open_pr_count: 1,
      merged_pr_count: 1,
      closed_unmerged_pr_count: 0,
      comment_count: 2,
    });
    expect(bob).toMatchObject({
      display_handle: 'Bob',
      pr_count: 1,
      open_pr_count: 1,
      merged_pr_count: 0,
      comment_count: 1,
    });
    expect(reviewer).toMatchObject({
      pr_count: 0,
      comment_count: 1,
    });
    expect(stalePr?.state).toBe('merged');
    expect(syncedComment?.author_handle).toBe('alice');
  });

  test('an unchanged sync writes only its progress marker, including closed PR history', async () => {
    const paginate = mockState.octokit.paginate.getMockImplementation()!;
    mockState.octokit.paginate.mockImplementation(async (endpoint: unknown, params: any) => {
      if (endpoint === mockState.pullsList && params.state === 'closed') {
        return [{ number: 4, title: 'Merged PR', body: 'Already merged', user: { login: 'Carol' },
          head: { sha: 'sha-4' }, merged_at: '2026-04-01T10:00:00Z',
          created_at: '2026-04-01T09:00:00Z', updated_at: '2026-04-01T10:00:00Z' }];
      }
      return paginate(endpoint, params);
    });
    mockState.octokit.rest.search.issuesAndPullRequests.mockReset();
    mockState.octokit.rest.search.issuesAndPullRequests.mockResolvedValue({ data: { total_count: 1 } });
    await syncPullRequests();
    const before = (await db.get<{ n: number }>('SELECT total_changes() AS n'))!.n;
    const users = await db.all('SELECT * FROM github_users ORDER BY handle');

    await syncPullRequests();

    const after = (await db.get<{ n: number }>('SELECT total_changes() AS n'))!.n;
    expect(after - before).toBe(1);
    expect(await db.all('SELECT * FROM github_users ORDER BY handle')).toEqual(users);
    expect(await db.get('SELECT state FROM pull_requests WHERE number = 4')).toEqual({ state: 'merged' });
  });

  test.each(['open', 'closed', 'closed-in-history'])('replays a partial REST batch when the PR is now %s', async state => {
    mockState.octokit.rest.search.issuesAndPullRequests.mockReset();
    mockState.octokit.rest.search.issuesAndPullRequests.mockResolvedValue({ data: { total_count: 1 } });
    await db.run("INSERT INTO sync_state(key,value) VALUES ('last_sync_at','previous-success')");
    // Emulate REST D1, where runBatch applies statements sequentially. Fail
    // after the PR upsert but before its comments/files have been stored.
    let failed = false;
    const spy = vi.spyOn(db, 'runBatch').mockImplementation(async statements => {
      for (const statement of statements) {
        const failComment = state === 'open' && statement.sql.includes('INSERT INTO pr_comments') && statement.params[0] === 201;
        const failFile = state !== 'open' && statement.sql.includes('INSERT INTO pr_files') && statement.params[0] === 1;
        if (!failed && (failComment || failFile)) {
          failed = true;
          throw new Error('interrupted REST batch');
        }
        await db.run(statement.sql, statement.params);
      }
    });
    await expect(syncPullRequests()).rejects.toThrow('Sync incomplete');
    expect(await db.get('SELECT updated_at FROM pull_requests WHERE number=1'))
      .toEqual({ updated_at: '2026-04-01T10:00:00Z' });
    if (state === 'open') expect(await db.get('SELECT comment_id FROM pr_comments WHERE comment_id=201')).toBeNull();
    else expect(await db.all('SELECT filename FROM pr_files WHERE pr_number=1')).toEqual([]);
    expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
      .toEqual({ value: 'previous-success' });
    expect(await db.get("SELECT key FROM sync_state WHERE key='pending_pr:1'"))
      .toEqual({ key: 'pending_pr:1' });
    spy.mockRestore();
    if (state !== 'open') {
      const paginate = mockState.octokit.paginate.getMockImplementation()!;
      const prs = await paginate(mockState.pullsList, { state: 'open' });
      mockState.octokit.paginate.mockImplementation(async (endpoint: unknown, params: any) => {
        if (endpoint === mockState.pullsList && params.state === 'open') return prs.filter((pr: any) => pr.number !== 1);
        if (endpoint === mockState.pullsList && params.state === 'closed' && state === 'closed-in-history') {
          return [{ ...prs[0], merged_at: '2026-04-01T15:00:00Z' }];
        }
        return paginate(endpoint, params);
      });
      const get = mockState.octokit.rest.pulls.get.getMockImplementation()!;
      mockState.octokit.rest.pulls.get.mockImplementation(async (params: any) => {
        if (params.pull_number === 1) return { data: { ...prs[0], state: 'closed', merged: true, mergeable: true, mergeable_state: 'clean' } };
        return get(params);
      });
    }
    if (state === 'closed-in-history') {
      // Fail full replay once more. The lightweight closed-history pass must
      // not erase the durable marker for still-missing files.
      const retry = vi.spyOn(db, 'runBatch').mockImplementation(async statements => {
        for (const statement of statements) {
          if (statement.sql.includes('INSERT INTO pr_files') && statement.params[0] === 1) throw new Error('retry interrupted');
          await db.run(statement.sql, statement.params);
        }
      });
      await expect(syncPullRequests()).rejects.toThrow('Sync incomplete');
      expect(await db.get("SELECT key FROM sync_state WHERE key='pending_pr:1'"))
        .toEqual({ key: 'pending_pr:1' });
      expect(await db.all('SELECT filename FROM pr_files WHERE pr_number=1')).toEqual([]);
      expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
        .toEqual({ value: 'previous-success' });
      retry.mockRestore();
    }
    await syncPullRequests();
    expect(await db.get('SELECT comment_id FROM pr_comments WHERE comment_id=201'))
      .toEqual({ comment_id: 201 });
    expect(await db.get("SELECT key FROM sync_state WHERE key='pending_pr:1'")).toBeNull();
    expect(await db.all('SELECT filename FROM pr_files WHERE pr_number=1'))
      .toEqual([{ filename: 'src/web/routes.ts' }]);
    expect(await db.get('SELECT state FROM pull_requests WHERE number=1'))
      .toEqual({ state: state === 'open' ? 'open' : 'merged' });
    expect(await db.get("SELECT comment_count FROM github_users WHERE handle='alice'"))
      .toEqual({ comment_count: 2 });
    expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
      .not.toEqual({ value: 'previous-success' });
  });

  test('retries aggregate failures even when every PR is unchanged, without advancing success early', async () => {
    mockState.octokit.rest.search.issuesAndPullRequests.mockReset();
    mockState.octokit.rest.search.issuesAndPullRequests.mockResolvedValue({ data: { total_count: 1 } });
    await db.run("INSERT INTO sync_state(key,value) VALUES ('last_sync_at','previous-success')");
    const run = db.run.bind(db);
    const spy = vi.spyOn(db, 'run').mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO github_users')) throw new Error('aggregate interrupted');
      return run(sql, params);
    });
    await expect(syncPullRequests()).rejects.toThrow('aggregate interrupted');
    expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
      .toEqual({ value: 'previous-success' });
    spy.mockRestore();
    mockState.octokit.rest.pulls.get.mockClear();
    await syncPullRequests();
    expect(mockState.octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(await db.get("SELECT comment_count FROM github_users WHERE handle='alice'"))
      .toEqual({ comment_count: 2 });
    expect(await db.all("SELECT key FROM sync_state WHERE key >= 'pending_user:' AND key < 'pending_user;'"))
      .toEqual([]);
    expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
      .not.toEqual({ value: 'previous-success' });
  });

  test('reports historical lookup 404s as gaps, preserves cached data/replay markers, and retries until recovered', async () => {
    mockState.octokit.rest.search.issuesAndPullRequests.mockReset();
    mockState.octokit.rest.search.issuesAndPullRequests.mockResolvedValue({ data: { total_count: 1 } });
    await db.run("INSERT INTO sync_state(key,value) VALUES ('last_sync_at','previous-success'), ('pending_pr:3','retry-token')");
    const get = mockState.octokit.rest.pulls.get.getMockImplementation()!;
    mockState.octokit.rest.pulls.get.mockImplementation(async (params: any) => {
      if (params.pull_number === 3) throw Object.assign(new Error('Not Found'), { status: 404 });
      return get(params);
    });
    const before = await db.get('SELECT * FROM pull_requests WHERE number=3');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await syncPullRequests();
      expect(warning.mock.calls.flat().join('\n')).toContain('Sync finished with gaps');
      expect(await db.get('SELECT * FROM pull_requests WHERE number=3')).toEqual(before);
      expect(await db.get("SELECT value FROM sync_state WHERE key='pending_pr:3'"))
        .toEqual({ value: 'retry-token' });
      expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
        .toEqual({ value: 'previous-success' });
      const app = createApp(async () => db, '<html></html>');
      const response = await app.request('http://example.test/api/stats');
      expect(await response.json()).toMatchObject({ lastSyncAt: 'previous-success', unavailablePRs: [3] });
      await syncPullRequests();
      expect(mockState.octokit.rest.pulls.get.mock.calls.filter(([p]: any[]) => p.pull_number === 3)).toHaveLength(2);
      mockState.octokit.rest.pulls.get.mockImplementation(async (params: any) => {
        if (params.pull_number !== 3) return get(params);
        return { data: { number: 3, title: 'Recovered PR', body: 'Body', user: { login: 'Alice' },
          head: { sha: 'sha-old' }, labels: [], state: 'closed', merged: true, mergeable: true,
          created_at: '2026-03-31T10:00:00Z', updated_at: '2026-04-02T10:00:00Z' } };
      });
      await syncPullRequests();
      expect(await db.get('SELECT state FROM pull_requests WHERE number=3')).toEqual({ state: 'merged' });
      expect(await db.get("SELECT value FROM sync_state WHERE key='pending_pr:3'")).toBeNull();
      expect(await db.get("SELECT value FROM sync_state WHERE key='unavailable_prs'"))
        .toEqual({ value: '[]' });
      expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
        .not.toEqual({ value: 'previous-success' });
    } finally { warning.mockRestore(); }
  });

  test.each([401, 403, 429, 500, undefined, '404'])('fails historical lookups with status %s instead of treating them as unavailable', async status => {
    await db.run("INSERT INTO sync_state(key,value) VALUES ('last_sync_at','previous-success')");
    const get = mockState.octokit.rest.pulls.get.getMockImplementation()!;
    mockState.octokit.rest.pulls.get.mockImplementation(async (params: any) => {
      if (params.pull_number === 3) throw Object.assign(new Error('404 text alone is not a status'), { status });
      return get(params);
    });
    await expect(syncPullRequests()).rejects.toThrow('Sync incomplete');
    expect(await db.get('SELECT state FROM pull_requests WHERE number=3')).toEqual({ state: 'open' });
    expect(await db.get("SELECT value FROM sync_state WHERE key='unavailable_prs'"))
      .toEqual({ value: '[]' });
    expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
      .toEqual({ value: 'previous-success' });
  });

  test.each(['current-detail', 'historical-comments', 'historical-write'])('does not tolerate 404 from %s', async source => {
    await db.run("INSERT INTO sync_state(key,value) VALUES ('last_sync_at','previous-success')");
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    if (source === 'current-detail') {
      const get = mockState.octokit.rest.pulls.get.getMockImplementation()!;
      mockState.octokit.rest.pulls.get.mockImplementation(async (params: any) => {
        if (params.pull_number === 1) throw notFound;
        return get(params);
      });
    } else if (source === 'historical-comments') {
      await db.run("INSERT INTO sync_state(key,value) VALUES ('pending_pr:3','retry-token')");
      const paginate = mockState.octokit.paginate.getMockImplementation()!;
      mockState.octokit.paginate.mockImplementation(async (endpoint: unknown, params: any) => {
        if (endpoint === mockState.listComments && params.issue_number === 3) throw notFound;
        return paginate(endpoint, params);
      });
      const get = mockState.octokit.rest.pulls.get.getMockImplementation()!;
      mockState.octokit.rest.pulls.get.mockImplementation(async (params: any) => {
        if (params.pull_number === 3) return { data: { number: 3, head: { sha: 'sha-old' }, state: 'closed', merged: true } };
        return get(params);
      });
    } else {
      const run = db.run.bind(db);
      vi.spyOn(db, 'run').mockImplementation(async (sql, params) => {
        if (sql.startsWith('UPDATE pull_requests SET state')) throw notFound;
        return run(sql, params);
      });
    }
    await expect(syncPullRequests()).rejects.toThrow('Sync incomplete');
    expect(await db.get("SELECT value FROM sync_state WHERE key='unavailable_prs'"))
      .toEqual({ value: '[]' });
    expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
      .toEqual({ value: 'previous-success' });
  });

  test('does not report complete freshness when pagination misses a still-open PR', async () => {
    await db.run("INSERT INTO sync_state(key,value) VALUES ('last_sync_at','previous-success')");
    const get = mockState.octokit.rest.pulls.get.getMockImplementation()!;
    mockState.octokit.rest.pulls.get.mockImplementation(async (params: any) => {
      if (params.pull_number === 3) return { data: { state: 'open' } };
      return get(params);
    });
    await expect(syncPullRequests()).rejects.toThrow('Sync incomplete');
    expect(await db.get("SELECT value FROM sync_state WHERE key='last_sync_at'"))
      .toEqual({ value: 'previous-success' });
  });
});
