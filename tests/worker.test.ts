import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/web/index.html', () => ({ default: '<!doctype html><title>dashboard</title>' }));
vi.mock('../src/web/favicon.svg', () => ({ default: '<svg></svg>' }));

import worker from '../src/web/worker';

describe('Worker read-only requests', () => {
  test('serves HTML and favicons even when the database is unavailable', async () => {
    const prepare = vi.fn(() => { throw new Error('D1 unavailable'); });
    const exec = vi.fn(() => { throw new Error('D1 write quota exceeded'); });
    const env = { DB: { prepare, exec } } as any;

    for (const path of ['/', '/leaderboard', '/authors/alice', '/pr/1', '/search']) {
      const response = await worker.fetch(new Request(`https://example.com${path}`), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<title>dashboard</title>');
    }
    const favicon = await worker.fetch(new Request('https://example.com/favicon.svg'), env);
    expect(favicon.status).toBe(200);
    expect(await favicon.text()).toBe('<svg></svg>');
    expect((await worker.fetch(new Request('https://example.com/favicon.ico'), env)).status).toBe(301);
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  test('reads API data without migrations or writes when writes are blocked', async () => {
    const write = vi.fn(() => { throw new Error('D1 write quota exceeded'); });
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({
        first: async () => sql.includes('COUNT') ? { cnt: 3 } : null,
        run: write,
      }),
    }));
    const response = await worker.fetch(new Request('https://example.com/api/stats'), {
      DB: { prepare, exec: write, batch: write },
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalPRs: 3, openPRs: 3, totalComments: 3 });
    expect(prepare.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  test('keeps warm API reads across requests and isolates different database bindings', async () => {
    const prepare = vi.fn((sql: string) => ({
      bind: () => ({ first: async () => sql.includes('COUNT') ? { cnt: 3 } : null }),
    }));
    const env = { DB: { prepare } } as any;
    const request = new Request('https://example.com/api/stats');
    expect((await worker.fetch(request, env)).status).toBe(200);
    const reads = prepare.mock.calls.length;
    const warm = await worker.fetch(request, env);
    expect(warm.headers.get('X-PR-Cache')).toBe('hit');
    expect(prepare).toHaveBeenCalledTimes(reads);
    expect((await worker.fetch(request, { DB: { prepare } } as any)).headers.get('X-PR-Cache')).toBe('miss');
    expect(prepare).toHaveBeenCalledTimes(reads * 2);
  });
});
