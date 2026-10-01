# GitHub Actions sync setup

This repository includes a scheduled workflow at `.github/workflows/sync-pr-data.yml` that runs the existing `sync` CLI every 15 minutes and writes into Cloudflare D1.

The Worker only reads the database; it does not perform migrations on page loads.
Before serving a newly created database, run `npm run build` and
`node dist/cli.js init-db` with the database configuration below. This explicitly
initializes or migrates the database without fetching GitHub data. The `sync`
command also checks and applies migrations before syncing.

Contributor refreshes normalize only changed handles and update only changed
summaries, preserving their creation dates. Unchanged closed/merged PRs and
repository counts are not rewritten; an unchanged sync only updates its
`last_sync_at` progress marker.

## What the workflow expects

The workflow reads:

- Repository secret `PAPERCLIP_SYNC_GITHUB_TOKEN`
- Repository secret `CLOUDFLARE_D1_API_TOKEN`
- Repository variable `CLOUDFLARE_ACCOUNT_ID`
- Repository variable `CLOUDFLARE_D1_DATABASE_ID`

`PAPERCLIP_SYNC_GITHUB_TOKEN` is mapped to the app's `GITHUB_TOKEN` env var at runtime.

## Step-by-step setup

### 1. Create the GitHub token secret

1. In GitHub, open the repository that will run this workflow.
2. Create a fine-grained personal access token for `paperclipai/paperclip`.
3. Grant these repository permissions:
   - `Pull requests: Read`
   - `Issues: Read`
   - `Checks: Read`
4. Copy the token value.
5. In the repo, go to `Settings` -> `Secrets and variables` -> `Actions`.
6. Open the `Secrets` tab.
7. Click `New repository secret`.
8. Set the name to `PAPERCLIP_SYNC_GITHUB_TOKEN`.
9. Paste the token value and save it.

Use a dedicated token instead of the default GitHub Actions token because this project syncs data from `paperclipai/paperclip`, not from the workflow repository itself.

### 2. Create the Cloudflare D1 API token secret

1. In Cloudflare, open the account that owns the D1 database.
2. Go to `Manage Account` -> `API Tokens`.
3. Click `Create Token`.
4. Create a custom token.
5. Add the account permission `D1:Edit`.
6. Limit the token to the account that contains the database.
7. Create the token and copy the token value.
8. Back in GitHub, go to `Settings` -> `Secrets and variables` -> `Actions` -> `Secrets`.
9. Click `New repository secret`.
10. Set the name to `CLOUDFLARE_D1_API_TOKEN`.
11. Paste the token value and save it.

`D1:Edit` is required because the sync job writes PR, comment, check-run, and sync-state rows through the D1 HTTP API.

### 3. Add the Cloudflare account and database IDs

1. In GitHub, stay on `Settings` -> `Secrets and variables` -> `Actions`.
2. Open the `Variables` tab.
3. Click `New repository variable`.
4. Create `CLOUDFLARE_ACCOUNT_ID` with your Cloudflare account ID.
5. Create `CLOUDFLARE_D1_DATABASE_ID` with the target D1 database ID.

The current database ID checked into `wrangler.toml` is `75a1a683-e935-4eb8-a0ba-7349529ff692`. If you are using that same database, you can copy that value directly. The account ID should come from the Cloudflare dashboard for the owning account.

### 4. Run the workflow once manually

1. In GitHub, open the `Actions` tab.
2. Open `Sync PR Data`.
3. Click `Run workflow`.
4. Confirm the job completes successfully before waiting for the schedule.

## Schedule

The workflow cron is `*/15 * * * *`, which GitHub Actions evaluates in UTC.
