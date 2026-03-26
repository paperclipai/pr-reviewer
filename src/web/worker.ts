import { createApp } from './app';
import { D1BindingClient } from '../db/d1-binding';
import DASHBOARD_HTML from './index.html';
import DASHBOARD_FAVICON from './favicon.svg';

export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = new D1BindingClient(env.DB);
    const app = createApp(async () => client, DASHBOARD_HTML, DASHBOARD_FAVICON);
    return app.fetch(request);
  },
};
