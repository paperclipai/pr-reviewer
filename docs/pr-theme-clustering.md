# PR Theme Clustering Plan

## Decision

The best fit for this codebase is:

1. build a richer PR document from the data we already sync,
2. generate embeddings in a batch job,
3. build a hierarchical cluster tree offline,
4. store cluster snapshots and memberships in D1,
5. render a visual map from precomputed coordinates in the web UI.

This should stay inside the existing TypeScript + Cloudflare stack. We should not introduce a Python, Java, or notebook-style sidecar for v1.

## Why this fits the current repo

This repository already has the right separation of concerns:

- `src/github/sync.ts` is the batch ingest path that writes PRs, comments, files, checks, and metadata into D1.
- `src/llm/review.ts` shows a second offline enrichment pass that stores derived analysis per PR.
- `src/web/routes.ts` and `src/web/index.html` already expose and render derived views, including `/api/prs/:number/similar`.

That means clustering should be treated as one more derived artifact, not as a live request-time computation in the Worker.

## Recommended architecture

### 1. Build a canonical PR document

For each PR, create one normalized document from:

- title
- body
- changed file paths
- commit subjects
- labels
- the latest LLM review summary, if present
- a short comment summary, capped to a small token budget

The file paths matter a lot in this repo. We should keep path tokens such as `src/web`, `src/github`, `tests`, `docs`, `wrangler`, and package names.

### 2. Generate embeddings in a batch step

Add a batch command that runs after sync and before UI reads:

- `pr-triage cluster --rebuild`

This should run in the same environment as the current sync and review jobs, not inside the request path.

Recommendation:

- use a hosted embeddings model from Cloudflare Workers AI so the stack stays close to the current deployment surface,
- do not plan around Anthropic for embeddings because Anthropic does not provide its own embeddings model.

### 3. Use hierarchical clustering, not HDBSCAN-first

The user-facing requirement is not just "group PRs". It is:

- coarse themes,
- drill-down into subthemes,
- zoom in and out in a visual map,
- support multiple resolutions.

Because of that, the first clustering primitive should be a hierarchy. For this codebase, the best v1 is:

- cosine similarity over PR embeddings,
- a k-nearest-neighbor graph or similarity matrix built offline,
- agglomerative hierarchical clustering or recursive threshold-based splitting,
- stored parent-child cluster relationships.

Why not HDBSCAN first:

- it is strongest in Python-centric tooling,
- it adds avoidable stack complexity for this repo,
- it is less natural for the UI requirement of stable zoom levels than an explicit hierarchy,
- our current data size is small enough that offline hierarchical clustering is practical.

HDBSCAN is still a good experiment later if cluster quality is weak, but it should not be the first production path here.

### 4. Store results in D1 as derived data

D1 should remain the source of truth for what the UI reads. The cluster pipeline should write compact, query-friendly tables such as:

```sql
CREATE TABLE pr_documents (
  pr_number INTEGER PRIMARY KEY REFERENCES pull_requests(number),
  document_text TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pr_embedding_runs (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE pr_embeddings (
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  run_id TEXT NOT NULL REFERENCES pr_embedding_runs(id),
  embedding_json TEXT NOT NULL,
  PRIMARY KEY (pr_number, run_id)
);

CREATE TABLE cluster_runs (
  id TEXT PRIMARY KEY,
  embedding_run_id TEXT NOT NULL REFERENCES pr_embedding_runs(id),
  algorithm TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES cluster_runs(id),
  parent_cluster_id TEXT REFERENCES clusters(id),
  depth INTEGER NOT NULL,
  label TEXT NOT NULL,
  summary TEXT,
  item_count INTEGER NOT NULL,
  centroid_x REAL,
  centroid_y REAL
);

CREATE TABLE cluster_memberships (
  run_id TEXT NOT NULL REFERENCES cluster_runs(id),
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  pr_number INTEGER NOT NULL REFERENCES pull_requests(number),
  depth INTEGER NOT NULL,
  similarity REAL,
  x REAL,
  y REAL,
  PRIMARY KEY (run_id, cluster_id, pr_number)
);
```

For v1, keeping embeddings in D1 as JSON is acceptable because the corpus is small. The UI does not need raw vectors. It needs cluster membership, labels, and coordinates.

### 5. Only add Vectorize if we need neighbor queries

Vector search is useful for:

- "show me related PRs",
- graph edge generation,
- fast nearest-neighbor lookup for one PR against many.

It is not required for initial clustering. If we want a fast semantic-neighbor API later, add Cloudflare Vectorize as a secondary index while keeping the canonical cluster snapshots in D1.

## UI shape

The visual map should be precomputed, not laid out live in the browser.

Recommended response model:

- `/api/themes`
  - returns cluster nodes for a chosen depth
- `/api/themes/:id`
  - returns cluster metadata, child clusters, and exemplar PRs
- `/api/themes/:id/prs`
  - returns PR memberships for that cluster

Each cluster row should already include:

- label
- summary
- item count
- representative PRs
- `x` and `y` coordinates for map placement
- parent and child ids

The browser then only has to:

- render the current depth,
- click into a cluster,
- swap from parent nodes to child nodes,
- optionally show individual PR dots inside the selected cluster.

That gives us stable zoom levels without recomputing clustering in the Worker or browser.

## Labeling strategy

Label quality matters more than squeezing small gains out of the clusterer.

For each cluster:

1. collect top path prefixes,
2. collect top title/body n-grams,
3. collect exemplar PR titles,
4. run a small LLM labeling pass that returns:
   - a short label,
   - a one-sentence summary,
   - 3 representative PRs.

We should also peel off obvious rule-based buckets before semantic clustering:

- docs-only
- CI-only
- dependency bumps
- test-only maintenance

That will make the semantic clusters cleaner.

## Implementation phases

### Phase 1

- Add schema for PR documents, embedding runs, clusters, and memberships.
- Add a `cluster` CLI command that:
  - builds PR documents,
  - embeds them,
  - computes a hierarchy,
  - generates labels,
  - writes one cluster run to D1.
- Add read-only API routes for themes and cluster detail.
- Add a basic map view that renders precomputed coordinates.

### Phase 2

- Add incremental updates keyed by PR document hash.
- Add neighbor search backed by Vectorize if needed.
- Add manual merge, split, and rename operations for cluster curation.

### Phase 3

- Learn from manual edits and promote stable themes into explicit tags or a lightweight classifier.

## Concrete recommendation

Ship a TypeScript batch pipeline that produces:

- one PR document per PR,
- one embedding per PR,
- one hierarchical cluster run,
- one labeled map snapshot for the UI.

Use D1 for the authoritative cluster state. Add Vectorize later only if we need fast semantic-neighbor queries. Avoid a Python-only HDBSCAN stack for v1 because it does not match the existing deployment model as well as an offline hierarchical TypeScript pipeline.
