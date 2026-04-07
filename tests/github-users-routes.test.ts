import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';

import { initializeDb } from '../src/db/bootstrap';
import { SqliteClient } from '../src/db/sqlite';
import type { DbClient } from '../src/db/types';
import { rebuildGitHubUsers } from '../src/github/users';
import { createRoutes } from '../src/web/routes';

describe('github user routes', () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reviewer-routes-'));
    db = await initializeDb(new SqliteClient(path.join(tempDir, 'test.sqlite')));
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('serves aggregated github author pages and PR author links', async () => {
    await db.run(`
      INSERT INTO pull_requests (number, title, body, author, author_handle, head_sha, mergeable, mergeable_state, state, labels_json, additions, deletions, changed_files, created_at, updated_at, fetched_at)
      VALUES
        (1, 'Open PR', 'Open body', 'Alice', 'alice', 'sha-1', 1, 'clean', 'open', '[]', 5, 1, 1, '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z'),
        (2, 'Closed PR', 'Closed body', 'Alice', 'alice', 'sha-2', 1, 'clean', 'closed', '[]', 10, 2, 3, '2026-04-02T10:00:00Z', '2026-04-03T11:00:00Z', '2026-04-03T11:00:00Z'),
        (3, 'Bob PR', 'Bob body', 'Bob', 'bob', 'sha-3', 1, 'clean', 'merged', '[]', 4, 4, 2, '2026-04-02T09:00:00Z', '2026-04-02T09:00:00Z', '2026-04-02T09:00:00Z')
    `);
    await db.run(`
      INSERT INTO pr_comments (comment_id, pr_number, author, author_handle, body, created_at, updated_at)
      VALUES
        (101, 2, 'Reviewer', 'reviewer', 'Needs tests before closing.', '2026-04-03T12:00:00Z', '2026-04-03T12:00:00Z'),
        (102, 2, 'Alice', 'alice', 'Closing this out after the failed experiment.', '2026-04-03T13:00:00Z', '2026-04-03T13:00:00Z'),
        (103, 1, 'Alice', 'alice', 'I will follow up on the review feedback.', '2026-04-01T12:00:00Z', '2026-04-01T12:00:00Z')
    `);
    await rebuildGitHubUsers(db);

    const app = new Hono();
    app.route('/api', createRoutes(async () => db));

    const profileRes = await app.request('http://example.test/api/github-users/alice');
    expect(profileRes.status).toBe(200);
    const profile = await profileRes.json();
    expect(profile.handle).toBe('alice');
    expect(profile.stats).toEqual({
      totalPRs: 2,
      openPRs: 1,
      mergedPRs: 0,
      closedUnmergedPRs: 1,
      comments: 2,
    });
    expect(profile.recentPRs[0]).toMatchObject({
      number: 2,
      state: 'closed',
      closureContext: 'Closing this out after the failed experiment.',
    });

    const prsRes = await app.request('http://example.test/api/prs?state=all&author=ALICE');
    expect(prsRes.status).toBe(200);
    const prs = await prsRes.json();
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({
      author: 'Alice',
      authorHandle: 'alice',
      authorProfileUrl: '#/authors/alice',
    });

    const commentsRes = await app.request('http://example.test/api/prs/2/comments');
    expect(commentsRes.status).toBe(200);
    const comments = await commentsRes.json();
    expect(comments[0]).toMatchObject({
      author: 'Reviewer',
      authorHandle: 'reviewer',
      authorProfileUrl: '#/authors/reviewer',
    });
  });
});
