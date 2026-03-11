import { loadConfig } from '../config';
import type { DbClient } from './types';

export type { DbClient };

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
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
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

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;
}
