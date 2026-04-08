import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';

import { initializeDb } from '../src/db/bootstrap';
import { SqliteClient } from '../src/db/sqlite';
import type { DbClient } from '../src/db/types';
import { createRoutes } from '../src/web/routes';
import { rebuildThemeClusters } from '../src/themes/cluster';

describe('theme clustering routes', () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reviewer-themes-'));
    db = await initializeDb(new SqliteClient(path.join(tempDir, 'test.sqlite')));
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('builds a theme run and serves overview/detail routes', async () => {
    await db.run(`
      INSERT INTO pull_requests (number, title, body, author, author_handle, head_sha, mergeable, mergeable_state, state, labels_json, additions, deletions, changed_files, created_at, updated_at, fetched_at)
      VALUES
        (101, 'Polish docs for setup', 'Refreshes installation and onboarding docs', 'Alice', 'alice', 'sha-101', 1, 'clean', 'open', '[]', 4, 1, 2, '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z'),
        (102, 'Expand docs examples', 'Adds more CLI examples to the docs', 'Bob', 'bob', 'sha-102', 1, 'clean', 'open', '[]', 6, 2, 3, '2026-04-01T11:00:00Z', '2026-04-01T11:00:00Z', '2026-04-01T11:00:00Z'),
        (201, 'Refine CLI auth flow', 'Touches the CLI auth prompts and login flow', 'Carol', 'carol', 'sha-201', 1, 'clean', 'open', '[]', 24, 12, 4, '2026-04-02T10:00:00Z', '2026-04-02T10:00:00Z', '2026-04-02T10:00:00Z'),
        (202, 'CLI auth retry fixes', 'Retry strategy for auth and token refresh', 'Dave', 'dave', 'sha-202', 1, 'clean', 'open', '[]', 22, 10, 4, '2026-04-02T11:00:00Z', '2026-04-02T11:00:00Z', '2026-04-02T11:00:00Z')
    `);

    await db.run(`
      INSERT INTO pr_files (pr_number, filename, status)
      VALUES
        (101, 'docs/setup.md', 'modified'),
        (101, 'docs/faq.md', 'modified'),
        (102, 'docs/cli/examples.md', 'modified'),
        (102, 'README.md', 'modified'),
        (201, 'packages/cli/src/auth.ts', 'modified'),
        (201, 'packages/cli/src/login.ts', 'modified'),
        (202, 'packages/cli/src/auth/retry.ts', 'modified'),
        (202, 'packages/cli/src/token-store.ts', 'modified')
    `);

    const result = await rebuildThemeClusters({ state: 'open' }, db);
    expect(result.itemCount).toBe(4);
    expect(result.clusterCount).toBeGreaterThan(0);

    const app = new Hono();
    app.route('/api', createRoutes(async () => db));

    const overviewRes = await app.request('http://example.test/api/themes');
    expect(overviewRes.status).toBe(200);
    const overview = await overviewRes.json();
    expect(overview.run.itemCount).toBe(4);
    expect(overview.clusters.length).toBeGreaterThan(0);
    const docsCluster = overview.clusters.find((cluster: any) => cluster.label === 'Documentation');
    expect(docsCluster).toBeTruthy();

    const detailRes = await app.request(`http://example.test/api/themes/${encodeURIComponent(docsCluster.id)}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.cluster.label).toBe('Documentation');
    expect(detail.prs.length).toBeGreaterThan(0);
    expect(detail.prs[0]).toMatchObject({
      number: expect.any(Number),
      title: expect.any(String),
      authorProfileUrl: expect.stringContaining('/#/authors/'),
    });
  });
});
