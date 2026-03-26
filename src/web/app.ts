import { Hono } from 'hono';
import { createRoutes } from './routes';
import type { DbClient } from '../db/types';
import FAVICON_SVG from './favicon.svg';

export function createApp(getDb: () => Promise<DbClient>, html: string): Hono {
  const app = new Hono();
  app.route('/api', createRoutes(getDb));
  app.get('/favicon.svg', (c) => {
    return c.body(FAVICON_SVG, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    });
  });
  app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));
  app.get('/', (c) => c.html(html));
  return app;
}
