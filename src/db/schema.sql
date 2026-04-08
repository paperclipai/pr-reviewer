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

CREATE TABLE IF NOT EXISTS theme_pr_documents (
  pr_number INTEGER PRIMARY KEY REFERENCES pull_requests(number),
  document_text TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS theme_runs (
  id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL,
  state_filter TEXT NOT NULL DEFAULT 'open',
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_theme_runs_created_at ON theme_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS theme_clusters (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES theme_runs(id) ON DELETE CASCADE,
  parent_cluster_id TEXT REFERENCES theme_clusters(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  avg_score INTEGER NOT NULL DEFAULT 0,
  centroid_x REAL NOT NULL DEFAULT 50,
  centroid_y REAL NOT NULL DEFAULT 50,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  exemplar_prs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_theme_clusters_run_parent ON theme_clusters(run_id, parent_cluster_id);
CREATE INDEX IF NOT EXISTS idx_theme_clusters_parent ON theme_clusters(parent_cluster_id);

CREATE TABLE IF NOT EXISTS theme_cluster_memberships (
  run_id TEXT NOT NULL REFERENCES theme_runs(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL REFERENCES theme_clusters(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number) ON DELETE CASCADE,
  depth INTEGER NOT NULL,
  similarity REAL NOT NULL DEFAULT 0,
  x REAL NOT NULL DEFAULT 50,
  y REAL NOT NULL DEFAULT 50,
  rank INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, cluster_id, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_theme_memberships_cluster ON theme_cluster_memberships(cluster_id, rank ASC);
CREATE INDEX IF NOT EXISTS idx_theme_memberships_pr ON theme_cluster_memberships(pr_number);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
