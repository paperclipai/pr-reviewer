CREATE TABLE IF NOT EXISTS pull_requests (
  number INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  mergeable INTEGER, -- 1=true, 0=false, NULL=unknown
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

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
