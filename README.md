# PR Triage Dashboard

The PR triage dashboard for [paperclipai/paperclip](https://github.com/paperclipai/paperclip). It syncs open (and recent closed/merged) pull requests from GitHub, scores them, and presents a ranked list to help maintainers decide what to review next.

**Live dashboard:** https://pr-triage.bippadotta.workers.dev

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
