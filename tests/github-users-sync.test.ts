import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { initializeDb } from '../src/db/bootstrap';
import { SqliteClient } from '../src/db/sqlite';
import type { DbClient } from '../src/db/types';

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
});
