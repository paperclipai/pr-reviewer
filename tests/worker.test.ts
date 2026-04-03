import { beforeEach, describe, expect, test, vi } from 'vitest';

const initializeDb = vi.fn(async (db: unknown) => db);
const createApp = vi.fn((getDb: () => Promise<unknown>) => ({
  fetch: async () => {
    await getDb();
    return new Response('ok', { status: 200 });
  },
}));
const D1BindingClient = vi.fn(function FakeD1BindingClient(this: Record<string, unknown>, d1: unknown) {
  this.d1 = d1;
});

vi.mock('../src/db/client', () => ({
  initializeDb,
}));

vi.mock('../src/db/bootstrap', () => ({
  initializeDb,
}));

vi.mock('../src/web/app', () => ({
  createApp,
}));

vi.mock('../src/db/d1-binding', () => ({
  D1BindingClient,
}));

vi.mock('../src/web/index.html', () => ({
  default: '<!doctype html><title>test</title>',
}));

describe('worker D1 bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    initializeDb.mockClear();
    createApp.mockClear();
    D1BindingClient.mockClear();
  });

  test('initializes the bound database once before serving requests', async () => {
    const workerModule = await import('../src/web/worker');
    const worker = workerModule.default;
    const env = { DB: { binding: 'db' } } as any;

    const firstResponse = await worker.fetch(new Request('https://example.com/api/stats'), env);
    const secondResponse = await worker.fetch(new Request('https://example.com/api/session'), env);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(D1BindingClient).toHaveBeenCalledTimes(1);
    expect(initializeDb).toHaveBeenCalledTimes(1);
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(initializeDb).toHaveBeenCalledWith(expect.objectContaining({ d1: env.DB }));
  });
});
