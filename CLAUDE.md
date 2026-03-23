# PR Triage Dashboard

## Scoring algorithm

All scoring constants, thresholds, detection patterns, and scoring functions live in `src/scoring.ts`. This is the single source of truth for how PRs are ranked.

**Important:** When you modify `src/scoring.ts` (changing thresholds, adding/removing signals, adjusting weights), you MUST also update the scoring documentation in `README.md` to keep them in sync. The README describes the algorithm in plain English for contributors — it should always reflect what the code actually does.

## Deployment

The dashboard is deployed as a Cloudflare Worker via `npx wrangler deploy`. Credentials are in `.dev.vars` (gitignored):

- `CLOUDFLARE_API_TOKEN` — scoped API token with Workers Scripts + D1 permissions
- `CLOUDFLARE_ACCOUNT_ID` — the target Cloudflare account

To deploy: `source .dev.vars && export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID && npx wrangler deploy`
