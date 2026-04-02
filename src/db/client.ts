import { loadConfig } from '../config';
import type { DbClient, BatchStatement } from './types';

export type { DbClient, BatchStatement };

let _db: DbClient | null = null;

/** Allow the Worker entrypoint to inject a pre-configured DB client */
export function setDb(db: DbClient): void {
  _db = db;
}

export async function getDb(): Promise<DbClient> {
  if (_db) return _db;

  const config = loadConfig();

  if (config.DB_BACKEND === 'd1') {
    const { D1Client } = await import('./d1');
    _db = new D1Client(config.D1_ACCOUNT_ID!, config.D1_DATABASE_ID!, config.D1_API_TOKEN!);
  } else {
    const { SqliteClient } = await import('./sqlite');
    _db = new SqliteClient(config.DB_PATH);
  }

  await _db.exec(getSchema());
  await runMigrations(_db);
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

async function runMigrations(db: DbClient): Promise<void> {
  // Add state column to pull_requests if missing (safe to fail if already exists)
  try {
    await db.run(`ALTER TABLE pull_requests ADD COLUMN state TEXT NOT NULL DEFAULT 'open'`);
  } catch {
    // Column already exists
  }
  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_pr_state ON pull_requests(state)`);
  } catch {
    // Index already exists
  }
  // Add labels_json column
  try {
    await db.run(`ALTER TABLE pull_requests ADD COLUMN labels_json TEXT DEFAULT '[]'`);
  } catch {
    // Column already exists
  }
  // Add LOC columns
  for (const col of ['additions', 'deletions', 'changed_files']) {
    try {
      await db.run(`ALTER TABLE pull_requests ADD COLUMN ${col} INTEGER DEFAULT 0`);
    } catch {
      // Column already exists
    }
  }
  for (const statement of [
    `ALTER TABLE users ADD COLUMN clips_balance INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN total_clips_won INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN avatar_url TEXT`,
    `ALTER TABLE users ADD COLUMN verified_type TEXT`,
    `ALTER TABLE users ADD COLUMN subscription_type TEXT`,
  ]) {
    try {
      await db.run(statement);
    } catch {
      // Column already exists or table not present yet
    }
  }
  try {
    await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS pr_search_fts USING fts5(number UNINDEXED, title, body)`);
  } catch {
    // Virtual table already exists
  }
}

function getSchema(): string {
  // Inline the schema so it works in both local and bundled/Docker contexts
  return `
CREATE TABLE IF NOT EXISTS pull_requests (
  number INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  mergeable INTEGER,
  mergeable_state TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  labels_json TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS greptile_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  comment_id INTEGER UNIQUE NOT NULL,
  confidence_score INTEGER NOT NULL CHECK(confidence_score BETWEEN 1 AND 5),
  comment_body TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_greptile_pr ON greptile_scores(pr_number);

CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(pr_number, name)
);

CREATE INDEX IF NOT EXISTS idx_checks_pr ON check_runs(pr_number);

CREATE TABLE IF NOT EXISTS llm_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  review_json TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_pr ON llm_reviews(pr_number);

CREATE TABLE IF NOT EXISTS pr_comments (
  comment_id INTEGER PRIMARY KEY,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_pr ON pr_comments(pr_number);

CREATE VIRTUAL TABLE IF NOT EXISTS pr_comments_fts USING fts5(
  body,
  content=pr_comments,
  content_rowid=comment_id
);

CREATE VIRTUAL TABLE IF NOT EXISTS pr_search_fts USING fts5(
  number UNINDEXED,
  title,
  body
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  verified_type TEXT,
  subscription_type TEXT,
  clips_balance INTEGER NOT NULL DEFAULT 0,
  total_clips_won INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

CREATE TABLE IF NOT EXISTS clip_allocation_lots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number) ON DELETE CASCADE,
  clips_locked INTEGER NOT NULL,
  clips_remaining INTEGER NOT NULL,
  bonus_rate REAL NOT NULL,
  bonus_rate_bps INTEGER NOT NULL,
  position_start INTEGER NOT NULL,
  position_end INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_clip_lots_pr_status ON clip_allocation_lots(pr_number, status, created_at);
CREATE INDEX IF NOT EXISTS idx_clip_lots_user_status ON clip_allocation_lots(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS clip_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pr_number INTEGER REFERENCES pull_requests(number) ON DELETE SET NULL,
  lot_id TEXT REFERENCES clip_allocation_lots(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  delta_clips INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clip_ledger_user_created ON clip_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;
}
