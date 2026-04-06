import { Hono } from 'hono';
import { createRoutes } from './routes';
import type { DbClient } from '../db/types';

export function createApp(getDb: () => Promise<DbClient>, html: string): Hono {
  const app = new Hono();
  app.route('/api', createRoutes(getDb));
  app.get('/', (c) => c.html(html));
  // SPA catch-all: serve index.html for any non-API path
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.html(html);
  });
  return app;
}
