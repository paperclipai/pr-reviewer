import { createApp } from './app';
import { D1BindingClient } from '../db/d1-binding';
import DASHBOARD_HTML from './index.html';
import DASHBOARD_FAVICON from './favicon.svg';

export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The sync CLI owns schema initialization and migrations. Serving the
    // dashboard must never spend the write quota or fail before returning HTML.
    const app = createApp(async () => new D1BindingClient(env.DB), DASHBOARD_HTML, DASHBOARD_FAVICON);
    return app.fetch(request);
  },
};
