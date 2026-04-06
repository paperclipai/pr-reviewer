import { createApp } from './app';
import { D1BindingClient } from '../db/d1-binding';
import { initializeDb } from '../db/bootstrap';
import DASHBOARD_HTML from './index.html';

export interface Env {
  DB: D1Database;
}

let app: ReturnType<typeof createApp> | null = null;
let boundDb: Promise<D1BindingClient> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`DB initialization timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!boundDb) {
      const client = new D1BindingClient(env.DB);
      boundDb = withTimeout(initializeDb(client), 8000);
      // If init fails, clear so next request retries
      boundDb.catch(() => { boundDb = null; });
    }

    if (!app) {
      app = createApp(async () => await boundDb!, DASHBOARD_HTML);
    }

    return app.fetch(request);
  },
};
