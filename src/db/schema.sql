CREATE TABLE IF NOT EXISTS pull_requests (
  number INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  mergeable INTEGER, -- 1=true, 0=false, NULL=unknown
  mergeable_state TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  labels_json TEXT DEFAULT '[]',
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  changed_files INTEGER DEFAULT 0,
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
  author_handle TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_pr ON pr_comments(pr_number);
CREATE INDEX IF NOT EXISTS idx_pr_author_handle ON pull_requests(author_handle);
CREATE INDEX IF NOT EXISTS idx_comments_author_handle ON pr_comments(author_handle);

CREATE VIRTUAL TABLE IF NOT EXISTS pr_comments_fts USING fts5(
  body,
  content=pr_comments,
  content_rowid=comment_id
);

CREATE TABLE IF NOT EXISTS pr_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  filename TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(pr_number, filename)
);

CREATE INDEX IF NOT EXISTS idx_pr_files_pr ON pr_files(pr_number);
CREATE INDEX IF NOT EXISTS idx_pr_files_filename ON pr_files(filename);

CREATE TABLE IF NOT EXISTS github_users (
  handle TEXT PRIMARY KEY,
  display_handle TEXT NOT NULL,
  pr_count INTEGER NOT NULL DEFAULT 0,
  open_pr_count INTEGER NOT NULL DEFAULT 0,
  merged_pr_count INTEGER NOT NULL DEFAULT 0,
  closed_unmerged_pr_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  latest_pr_number INTEGER REFERENCES pull_requests(number) ON DELETE SET NULL,
  latest_pr_at TEXT,
  latest_comment_id INTEGER REFERENCES pr_comments(comment_id) ON DELETE SET NULL,
  latest_comment_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_users_pr_count ON github_users(pr_count DESC, comment_count DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
