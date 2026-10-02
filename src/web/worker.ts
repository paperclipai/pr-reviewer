import { createApp } from './app';
import { D1BindingClient } from '../db/d1-binding';
import { ReadCache } from './read-cache';
import DASHBOARD_HTML from './index.html';
import DASHBOARD_FAVICON from './favicon.svg';

export interface Env {
  DB: D1Database;
}

// Reuse the application and cache across requests, isolated by database binding.
const instances = new WeakMap<object, { app: ReturnType<typeof createApp>; cache: ReadCache }>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The sync CLI owns schema initialization and migrations. Serving the
    // dashboard must never spend the write quota or fail before returning HTML.
    let instance = instances.get(env.DB);
    if (!instance) {
      const db = new D1BindingClient(env.DB);
      const app = createApp(async () => db, DASHBOARD_HTML, DASHBOARD_FAVICON);
      const cache = new ReadCache(async () => {
        const row = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'last_sync_at'");
        return row?.value ?? null;
      });
      instance = { app, cache };
      instances.set(env.DB, instance);
    }
    const { app, cache } = instance;
    return cache.fetch(request, async () => app.fetch(request));
  },
};
