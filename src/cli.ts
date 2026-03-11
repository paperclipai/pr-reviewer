#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { syncPullRequests } from './github/sync';
import { listCandidates, getPRDetail, FilterOptions } from './scoring/filter';
import { displayTable, displayPRDetail } from './display';
import { reviewPR, reviewTopCandidates } from './llm/review';
import { closeDb } from './db/client';

const program = new Command();

program
  .name('pr-triage')
  .description('PR triage CLI for paperclipai/paperclip')
  .version('1.0.0');

program
  .command('sync')
  .description('Sync all open PRs from GitHub')
  .action(async () => {
    try {
      await syncPullRequests();
    } catch (err: any) {
      console.error(`Sync failed: ${err.message}`);
      process.exit(1);
    } finally {
      await closeDb();
    }
  });

program
  .command('list')
  .description('List PRs sorted by composite score')
  .option('--min-score <n>', 'Minimum greptile score (1-5)', parseInt)
  .option('--ci <status>', 'Filter by CI status (passing|failing|pending)')
  .option('--no-conflicts', 'Exclude PRs with merge conflicts')
  .option('--limit <n>', 'Max PRs to show', parseInt)
  .action(async (opts) => {
    try {
      const filterOpts: FilterOptions = {};
      if (opts.minScore) filterOpts.minScore = opts.minScore;
      if (opts.ci) filterOpts.ci = opts.ci;
      if (opts.conflicts === false) filterOpts.noConflicts = true;
      if (opts.limit) filterOpts.limit = opts.limit;

      const candidates = await listCandidates(filterOpts);
      displayTable(candidates);
    } catch (err: any) {
      console.error(`List failed: ${err.message}`);
      process.exit(1);
    } finally {
      await closeDb();
    }
  });

program
  .command('show <pr-number>')
  .description('Show detail for a specific PR')
  .action(async (prNumberStr) => {
    try {
      const prNumber = parseInt(prNumberStr, 10);
      const detail = await getPRDetail(prNumber);
      if (!detail) {
        console.error(`PR #${prNumber} not found. Run 'sync' first.`);
        process.exit(1);
      }
      displayPRDetail(detail);
    } catch (err: any) {
      console.error(`Show failed: ${err.message}`);
      process.exit(1);
    } finally {
      await closeDb();
    }
  });

program
  .command('review [pr-number]')
  .description('Run LLM review on a PR or top N candidates')
  .option('--top <n>', 'Review top N candidates', parseInt)
  .option('--min-score <n>', 'Minimum greptile score for --top', parseInt)
  .option('--ci <status>', 'CI filter for --top')
  .option('--no-conflicts', 'Exclude conflicts for --top')
  .action(async (prNumberStr, opts) => {
    try {
      if (prNumberStr) {
        const prNumber = parseInt(prNumberStr, 10);
        await reviewPR(prNumber);
      } else if (opts.top) {
        await reviewTopCandidates({
          top: opts.top,
          minScore: opts.minScore,
          ci: opts.ci,
          noConflicts: opts.conflicts === false,
        });
      } else {
        console.error('Provide a PR number or use --top N');
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`Review failed: ${err.message}`);
      process.exit(1);
    } finally {
      await closeDb();
    }
  });

program.parse();
