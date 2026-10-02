import { describe, expect, test, vi } from 'vitest';
import { ReadCache } from '../src/web/read-cache';

const request = (path = '/api/stats', init?: RequestInit) => new Request(`https://example.test${path}`, init);
const json = (value: unknown, status = 200) => Response.json(value, { status });

describe('public read cache', () => {
  test('reuses responses, checks revision once a minute, and invalidates on successful sync', async () => {
    let now = 0;
    let revision = 'first';
    const readRevision = vi.fn(async () => revision);
    const cache = new ReadCache(readRevision, { now: () => now });
    const next = vi.fn(async () => json({ revision }));
    expect(await (await cache.fetch(request(), next)).json()).toEqual({ revision: 'first' });
    expect((await cache.fetch(request(), next)).headers.get('X-PR-Cache')).toBe('hit');
    expect(readRevision).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    now = 60_001;
    await cache.fetch(request(), next);
    expect(readRevision).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledTimes(1);
    revision = 'second';
    now = 120_002;
    expect(await (await cache.fetch(request(), next)).json()).toEqual({ revision: 'second' });
    expect(next).toHaveBeenCalledTimes(2);
  });

  test('expires even without a successful sync, bounding stale partial writes and time-based scores', async () => {
    let now = 0;
    const cache = new ReadCache(async () => null, { now: () => now });
    const next = vi.fn(async () => json({ now }));
    await cache.fetch(request(), next);
    now = 299_999;
    expect(await (await cache.fetch(request(), next)).json()).toEqual({ now: 0 });
    now = 300_000;
    expect(await (await cache.fetch(request(), next)).json()).toEqual({ now });
    expect(next).toHaveBeenCalledTimes(2);
  });

  test('keeps query keys separate and coalesces concurrent misses', async () => {
    const cache = new ReadCache(async () => 'one');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const next = vi.fn(async () => { await gate; return json(['open']); });
    const first = cache.fetch(request('/api/prs?state=open'), next);
    const second = cache.fetch(request('/api/prs?state=open'), next);
    release();
    const responses = await Promise.all([first, second]);
    expect(await Promise.all(responses.map(response => response.json()))).toEqual([['open'], ['open']]);
    expect(next).toHaveBeenCalledTimes(1);
    await cache.fetch(request('/api/prs?state=closed'), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test('never caches errors, private responses or bypassed routes', async () => {
    const revision = vi.fn(async () => 'one');
    const cache = new ReadCache(revision);
    const failed = vi.fn(async () => json({ error: 'quota' }, 500));
    await cache.fetch(request(), failed);
    await cache.fetch(request(), failed);
    expect(failed).toHaveBeenCalledTimes(2);
    const privateResponse = vi.fn(async () => Response.json({}, { headers: { 'Cache-Control': 'private' } }));
    await cache.fetch(request(), privateResponse);
    await cache.fetch(request(), privateResponse);
    expect(privateResponse).toHaveBeenCalledTimes(2);
    const bypass = vi.fn(async () => json({}));
    for (const req of [request('/'), request('/api/sync'), request('/api/scoring'),
      request('/api/stats', { method: 'POST' }), request('/api/stats', { headers: { Authorization: 'test' } }),
      request('/api/stats', { headers: { Cookie: 'session=test' } })]) {
      await cache.fetch(req, bypass);
      await cache.fetch(req, bypass);
    }
    expect(bypass).toHaveBeenCalledTimes(12);
    expect(revision).toHaveBeenCalledTimes(1);
  });

  test('discards stale cache if revision read fails and never stores thrown failures', async () => {
    let now = 0;
    const revision = vi.fn(async () => 'one');
    const cache = new ReadCache(revision, { now: () => now });
    const next = vi.fn(async () => json({ count: 1 }));
    await cache.fetch(request(), next);
    now = 60_000;
    revision.mockRejectedValueOnce(new Error('quota'));
    const response = await cache.fetch(request(), async () => json({ error: 'quota' }, 500));
    expect(response.status).toBe(500);
    await expect(cache.fetch(request(), async () => { throw new Error('network'); })).rejects.toThrow('network');
    await cache.fetch(request(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  test('bounds retained responses by bytes and entry count', async () => {
    const cache = new ReadCache(async () => 'one', { maxEntries: 1, maxBytes: 20 });
    const next = vi.fn(async () => json({ n: 1 }));
    await cache.fetch(request('/api/prs'), next);
    await cache.fetch(request('/api/stats'), next);
    await cache.fetch(request('/api/prs'), next);
    expect(next).toHaveBeenCalledTimes(3);
    const large = vi.fn(async () => json('x'.repeat(100)));
    await cache.fetch(request('/api/authors'), large);
    await cache.fetch(request('/api/authors'), large);
    expect(large).toHaveBeenCalledTimes(2);
  });

  test('passes oversized streams through without buffering the rest or sharing the stream with followers', async () => {
    const cache = new ReadCache(async () => 'one', { maxEntryBytes: 8 });
    const pulls: number[] = [];
    const next = vi.fn(async () => {
      const index = pulls.length;
      pulls.push(0);
      return new Response(new ReadableStream({
        pull(controller) {
          const count = pulls[index]++;
          controller.enqueue(new TextEncoder().encode(count === 0 || count === 101 ? '"' : 'a'));
          if (count === 101) controller.close();
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    const [first, second] = await Promise.all([cache.fetch(request(), next), cache.fetch(request(), next)]);
    expect(next).toHaveBeenCalledTimes(2);
    expect(pulls[0]).toBeLessThan(102);
    expect(pulls[1]).toBeLessThan(102);
    expect(await first.json()).toBe('a'.repeat(100));
    expect(await second.json()).toBe('a'.repeat(100));
    const third = await cache.fetch(request(), next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(await third.json()).toBe('a'.repeat(100));
  });

  test('does not let an older in-flight result repopulate the cache after invalidation', async () => {
    let now = 0;
    let revision = 'old';
    const cache = new ReadCache(async () => revision, { now: () => now });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const old = cache.fetch(request(), async () => { await gate; return json('old'); });
    // Allow the old revision read and request to start.
    await new Promise(resolve => setTimeout(resolve, 0));
    revision = 'new';
    now = 60_001;
    expect(await (await cache.fetch(request(), async () => json('new'))).json()).toBe('new');
    release();
    expect(await (await old).json()).toBe('old');
    expect(await (await cache.fetch(request(), async () => json('wrong'))).json()).toBe('new');
  });
});
