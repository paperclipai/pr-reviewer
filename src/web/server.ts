import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { getDb, closeDb } from '../db/client';

// Read HTML at startup
const htmlPath = join(__dirname, '..', '..', 'src', 'web', 'index.html');
let html: string;
try {
  html = readFileSync(htmlPath, 'utf-8');
} catch {
  html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
}

const app = createApp(getDb, html);
const port = parseInt(process.env.PORT || '3000');

console.log(`PR Triage dashboard running at http://localhost:${port}`);
serve({ fetch: app.fetch, port });

process.on('SIGINT', async () => {
  await closeDb();
  process.exit(0);
});
