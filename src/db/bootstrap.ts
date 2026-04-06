import type { DbClient } from './types';

const initializationPromises = new WeakMap<DbClient, Promise<DbClient>>();
const SCHEMA_VERSION = '1';

async function execStatement(db: DbClient, sql: string): Promise<void> {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  const statement = normalized.endsWith(';') ? normalized : `${normalized};`;
  await db.exec(statement);
}

async function runMigrations(db: DbClient): Promise<void> {
  // Add state column to pull_requests if missing (safe to fail if already exists)
  try {
    await execStatement(db, `ALTER TABLE pull_requests ADD COLUMN state TEXT NOT NULL DEFAULT 'open'`);
  } catch {
    // Column already exists
  }
  try {
    await execStatement(db, `CREATE INDEX IF NOT EXISTS idx_pr_state ON pull_requests(state)`);
  } catch {
    // Index already exists
  }
  // Add labels_json column
  try {
    await execStatement(db, `ALTER TABLE pull_requests ADD COLUMN labels_json TEXT DEFAULT '[]'`);
  } catch {
    // Column already exists
  }
  // Add LOC columns
  for (const col of ['additions', 'deletions', 'changed_files']) {
    try {
      await execStatement(db, `ALTER TABLE pull_requests ADD COLUMN ${col} INTEGER DEFAULT 0`);
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
      await execStatement(db, statement);
    } catch {
      // Column already exists or table not present yet
    }
  }
  try {
    await execStatement(db, `CREATE VIRTUAL TABLE IF NOT EXISTS pr_search_fts USING fts5(number UNINDEXED, title, body)`);
  } catch {
    // Virtual table already exists or FTS5 not available
  }
}

export async function initializeDb<T extends DbClient>(db: T): Promise<T> {
  const existing = initializationPromises.get(db);
  if (existing) return await existing as T;

  const initialization = (async () => {
    if (await shouldInitializeSchema(db)) {
      for (const statement of getSchemaStatements()) {
        // FTS5 virtual tables may not be available on all D1 environments
        const isFts = /CREATE\s+VIRTUAL\s+TABLE/i.test(statement);
        try {
          await execStatement(db, statement);
        } catch (err) {
          if (isFts) {
            // FTS5 is optional - search will degrade gracefully
            console.warn('FTS5 table creation skipped:', (err as Error).message);
          } else {
            throw err;
          }
        }
      }
      await runMigrations(db);
      await db.run(
        `INSERT INTO sync_state (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [SCHEMA_VERSION],
      );
    }
    return db;
  })();

  initializationPromises.set(db, initialization);

  try {
    return await initialization as T;
  } catch (error) {
    initializationPromises.delete(db);
    throw error;
  }
}

export function getSchema(): string {
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

function getSchemaStatements(): string[] {
  return getSchema()
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function shouldInitializeSchema(db: DbClient): Promise<boolean> {
  try {
    const row = await db.get<{ value: string }>(
      `SELECT value FROM sync_state WHERE key = 'schema_version'`,
    );
    return row?.value !== SCHEMA_VERSION;
  } catch {
    return true;
  }
}
