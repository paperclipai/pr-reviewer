import { describe, expect, test } from 'vitest';

import { createApp } from '../src/web/app';

describe('web app html routes', () => {
  test('serves dashboard html on direct leaderboard and author paths', async () => {
    const app = createApp(async () => {
      throw new Error('DB should not be touched for HTML routes');
    }, '<!doctype html><title>dashboard</title>');

    const leaderboardRes = await app.request('http://example.test/leaderboard');
    const authorRes = await app.request('http://example.test/authors/alice');

    expect(leaderboardRes.status).toBe(200);
    expect(await leaderboardRes.text()).toContain('<title>dashboard</title>');
    expect(authorRes.status).toBe(200);
    expect(await authorRes.text()).toContain('<title>dashboard</title>');
  });
});
