# PR Triage Dashboard

The PR triage dashboard for [paperclipai/paperclip](https://github.com/paperclipai/paperclip). It syncs open (and recent closed/merged) pull requests from GitHub, scores them, and presents a ranked list to help maintainers decide what to review next.

**Live dashboard:** https://pr-triage.bippadotta.workers.dev

**Paperclip documentation:** https://docs.paperclip.ing

## Deploying

The dashboard runs as a Cloudflare Worker with a D1 database.

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.dev.vars` file in the project root with your Cloudflare credentials:
   ```
   CLOUDFLARE_API_TOKEN=your-api-token
   CLOUDFLARE_ACCOUNT_ID=your-account-id
   ```

   To create an API token, go to https://dash.cloudflare.com/profile/api-tokens and create a Custom Token with **Workers Scripts: Edit** and **D1: Edit** permissions.

3. Deploy:
   ```bash
   npx wrangler deploy
   ```

`.dev.vars` is gitignored and should never be committed.

Merges to `master` are automatically deployed via CI — manual deploys are only needed for initial setup or debugging.

## D1 read usage and freshness

Scheduled sync refreshes contributor summaries only for affected PR/comment authors.
It records pending work in the existing `sync_state` table before changing source
rows, because D1's REST client executes batches sequentially. Interrupted PR saves
are replayed even if the PR has since closed. Failed summary refreshes remain
queued, and `last_sync_at` advances only after the entire sync succeeds. The
existing workflow serializes sync jobs; other callers must also use a single sync
writer per database.

The first sync with this implementation performs one full contributor repair and
stores `incremental_users_version=1`. Later unchanged syncs read only queue/marker
rows for this stage. This adds no tables, columns, indexes, or schema-version
migration; it uses the normalized handles and indexes already created by schema
version 2. Existing data, scoring rules, and response shapes are preserved.

The Worker caches successful public API GET responses per database binding and
Worker isolate. It checks `last_sync_at` at most once per minute and clears cached
responses when the marker changes. Every response also expires five minutes after
its fetch started, bounding staleness after partial sync failures, out-of-band
writes, and time-based score changes. Revision-check failures discard the cache.
Authorization/cookie requests, errors, private responses, static routes, and sync
requests bypass it. The local Node server remains uncached.

The cache retains at most 64 responses / 16 MiB, accepts responses up to 4 MiB, and
coalesces at most four distinct fills. Oversized responses pass through without
being retained. Deployments/new isolates start cold. This reduces repeated reads
but does not guarantee that an account stays within the free quota.

On a local fixture with 11,000 PRs, 25,000 comments, and 165,000 files, compared with
commit `3dec121`, SQLite reported:

| Operation | Previous row visits | New row visits |
| --- | ---: | ---: |
| Default PR list, uncached | 246,875 | 96,051 |
| Author-filtered PR list | 209,090 | 221 |
| PR detail | 11,024 | 35 |
| Contributor profile | 36,118 | 146 |
| Similar PRs | 224,763 | 11,326 |
| Contributor refresh: full rebuild → one affected handle | 236,501 | 132 |

An unchanged contributor-refresh stage uses two marker queries and one indexed
row visit. A warm cached list uses zero database queries; its periodic unchanged
revision check uses one query/row. These stage measurements exclude the rest of
the scheduled sync. Cold stats queries are unchanged: 6,803 scan visits plus
36,000 rows counted through SQLite's fast `COUNT(*)` path, which scanstatus does
not report. Similar-PR ranking still compares all PR bodies; its lower read cost
does not establish that cold requests fit the Worker's CPU limit.

To reproduce locally, install dependencies with Node 22.18 or newer and run:

```bash
node --experimental-strip-types scripts/measure-read-cost.ts 3dec121
```

The script requires `clang`, compiles a SQLite scanstatus harness from the
repository's installed dependency, and writes synthetic fixtures, exact SQL,
query plans, response comparisons, and results under the system temporary
directory. It makes no GitHub or Cloudflare requests. It checks exact response
parity, including mixed-case authors, temporarily missing summaries, similarity
ranking, and cached responses. Measurements are local SQLite row visits, not
Cloudflare billed reads or Worker CPU measurements.

## How scoring works

Every PR receives a **composite score from 0 to 180**, built from ten signals. The goal is to surface PRs that are most likely to be worth reviewing right now — small, well-tested PRs from reliable contributors with passing CI will naturally float to the top.

### Base signals (0–115 points)

| Signal | Points | How it works |
|--------|--------|--------------|
| **Greptile confidence** | 0–40 | The Greptile bot leaves a confidence score (1–5) on each PR. Multiplied by 8. |
| **CI status** | 0–25 | Passing = 25, pending = 12, unknown = 8, failing = 0. |
| **Merge conflicts** | -15 to +15 | No conflicts = +15, has conflicts = -15. |
| **Human comments** | 0–20 | 1 comment = 10, 2+ comments = 20. Bot comments are excluded. |
| **Lines of code** | 0–15 | Smaller PRs score higher. Uses logarithmic decay: ~12 at 50 LOC, ~8 at 200, ~3 at 1000. |

### Contributor priority (-25 to +25 points)

Each author gets an internal priority score (0–100) based on their history, then mapped to -25 to +25 composite points. This means authors with a poor track record are actively deprioritized, not just scored neutrally.

The contributor score considers:
- **First-time contributors** get a +15 bonus
- **Track record** (0–10): based on how many PRs the author has merged
- **Merge rate** (smooth 5-tier gradient): 80%+ = +10, 60–79% = +5, 40–59% = 0 (neutral), 20–39% = -15, <20% = -30
- **Open PR load** (0–10): authors with many open PRs get a small boost since they need review bandwidth

### Bonus signals (0–40 points)

| Signal | Points | How it works |
|--------|--------|--------------|
| **Includes tests** | +10 | PR touches test files (`.test.`, `_test.`, `__tests__/`, `.spec.`, `_spec.`). |
| **Thinking Path** | +10 | PR description contains "Thinking Path", indicating the author documented their reasoning. |
| **Issue link** | +10 | PR description links to a GitHub issue (`closes #`, `fixes #`, `resolves #`, or `/issues/` URL). |
| **Freshness** | 0–10 | Newer PRs score higher: <1 day = 10, 1–3 days = 8, 3–7 days = 5, 1–2 weeks = 2, older = 0. |

### Tuning the algorithm

All scoring constants, thresholds, and logic live in [`src/scoring.ts`](src/scoring.ts). To adjust how PRs are ranked, that's the only file you need to change.

> **Keep docs in sync:** If you change the scoring algorithm in `src/scoring.ts`, update this README to match. The two should always agree.
