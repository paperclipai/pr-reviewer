import { Hono } from 'hono';
import { createRoutes } from './routes';
import type { DbClient } from '../db/types';

export function createApp(getDb: () => Promise<DbClient>, html: string, faviconSvg?: string): Hono {
  const app = new Hono();
  app.route('/api', createRoutes(getDb));
  if (faviconSvg) {
    app.get('/favicon.svg', (c) => {
      return c.body(faviconSvg, 200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      });
    });
  }
  app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));
  app.get('/', (c) => c.html(html));
  app.get('/leaderboard', (c) => c.html(html));
  app.get('/search', (c) => c.html(html));
  app.get('/pr/:number', (c) => c.html(html));
  app.get('/authors/:handle', (c) => c.html(html));
  return app;
}
