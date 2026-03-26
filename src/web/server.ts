import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { getDb, closeDb } from '../db/client';
import { syncPullRequests } from '../github/sync';

// Read HTML at startup
const htmlPath = join(__dirname, '..', '..', 'src', 'web', 'index.html');
let html: string;
try {
  html = readFileSync(htmlPath, 'utf-8');
} catch {
  html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
}

const app = createApp(getDb, html);

// Local-only sync endpoint (not available on Cloudflare Worker)
let syncing = false;
app.get('/api/sync', (c) => c.json({ available: true, syncing }));
app.post('/api/sync', async (c) => {
  if (syncing) return c.json({ error: 'Sync already in progress' }, 409);
  syncing = true;
  try {
    await syncPullRequests({});
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  } finally {
    syncing = false;
  }
});

const port = parseInt(process.env.PORT || '3000');

console.log(`PR Triage dashboard running at http://localhost:${port}`);
serve({ fetch: app.fetch, port });

process.on('SIGINT', async () => {
  await closeDb();
  process.exit(0);
});
