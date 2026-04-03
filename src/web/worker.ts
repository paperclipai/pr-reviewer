import { createApp } from './app';
import { D1BindingClient } from '../db/d1-binding';
import { initializeDb } from '../db/bootstrap';
import DASHBOARD_HTML from './index.html';

export interface Env {
  DB: D1Database;
}

let app: ReturnType<typeof createApp> | null = null;
let boundDb: Promise<D1BindingClient> | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!boundDb) {
      const client = new D1BindingClient(env.DB);
      boundDb = initializeDb(client);
    }

    if (!app) {
      app = createApp(async () => await boundDb!, DASHBOARD_HTML);
    }

    return app.fetch(request);
  },
};
