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

vi.mock('../src/web/favicon.svg', () => ({
  default: '<svg></svg>',
}));

describe('worker D1 bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    initializeDb.mockClear();
    createApp.mockClear();
    D1BindingClient.mockClear();
  });

  test('initializes the bound database before serving requests', async () => {
    const workerModule = await import('../src/web/worker');
    const worker = workerModule.default;
    const env = { DB: { binding: 'db' } } as any;

    const firstResponse = await worker.fetch(new Request('https://example.com/api/stats'), env);
    const secondResponse = await worker.fetch(new Request('https://example.com/api/prs'), env);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(D1BindingClient).toHaveBeenCalledTimes(2);
    expect(initializeDb).toHaveBeenCalledTimes(2);
    expect(createApp).toHaveBeenCalledTimes(2);
    expect(initializeDb).toHaveBeenCalledWith(expect.objectContaining({ d1: env.DB }));
  });
});
