import { Hono } from 'hono';
import { createRoutes } from './routes';
import type { DbClient } from '../db/types';

export function createApp(getDb: () => Promise<DbClient>, html: string): Hono {
  const app = new Hono();
  app.route('/api', createRoutes(getDb));
  app.get('/', (c) => c.html(html));
  return app;
}
