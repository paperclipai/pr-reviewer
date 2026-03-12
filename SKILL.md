# PR Triage API — Agent Skill Guide

Use this API to search, filter, and analyze pull requests for the `paperclipai/paperclip` repo. The API is read-only and requires no authentication.

**Base URL**: `https://pr-triage.bippadotta.workers.dev/api`

---

## Endpoints

### `GET /api/prs` — List and filter PRs

Returns PRs ranked by composite score (default) with full triage metadata.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `state` | `open\|merged\|closed\|all` | `open` | Filter by PR state |
| `minScore` | `1-5` | — | Minimum Greptile confidence score |
| `ci` | `passing\|failing\|pending` | — | Filter by CI status |
| `noConflicts` | `true` | — | Exclude PRs with merge conflicts |
| `author` | string | — | Filter by GitHub username (exact match) |
| `label` | string | — | Filter by label name (case-insensitive) |
| `sort` | `score\|updated\|created\|number\|comments` | `score` | Sort order (descending) |
| `limit` | number | — | Max results to return |

**Example**: Find the top 5 open PRs with passing CI, sorted by most recently active:
```
GET /api/prs?ci=passing&sort=updated&limit=5
```

**Response shape**:
```json
[{
  "number": 601,
  "title": "Add OAuth2 support",
  "author": "alice",
  "state": "open",
  "labels": [{"name": "feature", "color": "0e8a16"}],
  "greptileScore": 4,
  "ciStatus": "passing",
  "hasConflicts": false,
  "humanComments": 3,
  "compositeScore": 92,
  "createdAt": "2026-02-15T10:00:00Z",
  "lastActivity": "2026-03-11T14:30:00Z"
}]
```

### `GET /api/prs/:number` — PR detail with score breakdown

Returns full detail for a single PR including score breakdown, checks, Greptile scores, LLM reviews, and the PR body.

**Example**: `GET /api/prs/601`

**Response includes**:
- All fields from the list endpoint
- `body` — PR description text
- `headSha` — current head commit SHA
- `scoreBreakdown` — how the composite score was computed:
  ```json
  {
    "total": 92,
    "greptile": {"value": 32, "max": 40, "input": 4},
    "ci": {"value": 25, "max": 25, "input": "passing"},
    "conflicts": {"value": 15, "range": "-15 to +15", "input": false},
    "humanComments": {"value": 20, "max": 20, "input": 3}
  }
  ```
- `greptileScores` — all Greptile bot confidence scores for this PR
- `checks` — CI check run details (name, status, conclusion)
- `reviews` — LLM review results (recommendation, risk level, summary, reasoning)

### `GET /api/search?q=...` — Full-text search comments (BM25)

Searches all PR comments using SQLite FTS5 with BM25 ranking. Results are grouped by PR.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | **required** | Search query (supports FTS5 syntax: `AND`, `OR`, `NOT`, `"exact phrase"`, `prefix*`) |
| `limit` | number | `20` | Max comment matches to return |

**Example**: Find PRs discussing authentication:
```
GET /api/search?q=auth OR oauth OR authentication&limit=30
```

**Response shape**:
```json
{
  "query": "auth OR oauth",
  "totalMatches": 12,
  "prs": [{
    "pr_number": 601,
    "title": "Add OAuth2 support",
    "author": "alice",
    "state": "open",
    "labels": [{"name": "feature", "color": "0e8a16"}],
    "compositeScore": 92,
    "matches": [{
      "comment_id": 12345,
      "pr_number": 601,
      "author": "bob",
      "body": "This OAuth implementation looks solid...",
      "created_at": "2026-03-10T09:00:00Z",
      "rank": -1.5
    }]
  }]
}
```

**FTS5 query syntax tips**:
- `database migration` — matches comments containing both words
- `"database migration"` — matches the exact phrase
- `database OR migration` — matches either word
- `NOT migration` — excludes comments with "migration"
- `data*` — prefix matching (database, datastore, etc.)

### `GET /api/prs/:number/comments` — All comments for a PR

Returns all comments (including bot comments) in chronological order.

### `GET /api/labels` — List all labels

Returns all unique labels across PRs, sorted by frequency. Useful for discovering what labels exist before filtering.

**Response**: `[{"name": "bug", "color": "d73a4a", "count": 15}, ...]`

### `GET /api/authors` — List all authors

Returns all PR authors sorted by PR count. Useful for discovering usernames before filtering.

**Response**: `[{"author": "alice", "cnt": 12}, ...]`

### `GET /api/scoring` — Scoring formula explanation

Returns a machine-readable description of how composite scores are calculated.

### `GET /api/stats` — Repository statistics

Returns aggregate counts: open/merged/closed PRs, Greptile scored, LLM reviewed, total comments, last sync time.

---

## Common Agent Workflows

### "Find PRs about topic X"
```
GET /api/search?q=X&limit=30
```
Then use the `pr_number` from matches to get full detail: `GET /api/prs/{number}`

### "Which PRs are ready to merge?"
```
GET /api/prs?ci=passing&noConflicts=true&minScore=3&sort=score&limit=10
```

### "What has author X been working on?"
```
GET /api/prs?author=username&state=all&sort=updated
```

### "Find PRs with a specific label"
```
GET /api/prs?label=bug&sort=updated
```

### "What PRs changed recently?"
```
GET /api/prs?sort=updated&limit=20
```

### "Understand why a PR has a low score"
```
GET /api/prs/601
```
Check the `scoreBreakdown` field to see which signals are dragging the score down.

### "Get an overview of the repo"
```
GET /api/stats
GET /api/labels
GET /api/authors
```
