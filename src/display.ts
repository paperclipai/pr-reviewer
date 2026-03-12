import chalk from 'chalk';
import { PRCandidate } from './scoring/filter';
import { CIStatus } from './github/checks';

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function colorScore(score: number): string {
  if (score >= 70) return chalk.green(String(score));
  if (score >= 40) return chalk.yellow(String(score));
  return chalk.red(String(score));
}

function colorCI(status: CIStatus): string {
  switch (status) {
    case 'passing': return chalk.green('pass');
    case 'failing': return chalk.red('fail');
    case 'pending': return chalk.yellow('pend');
    case 'unknown': return chalk.gray('n/a');
  }
}

function colorConflicts(hasConflicts: boolean): string {
  return hasConflicts ? chalk.red('yes') : chalk.green('no');
}

export function displayTable(candidates: PRCandidate[]): void {
  if (candidates.length === 0) {
    console.log(chalk.yellow('No PRs match the given filters.'));
    return;
  }

  // Header
  const header = [
    pad('#', 6),
    pad('Title', 52),
    pad('Author', 16),
    pad('Greptile', 9),
    pad('CI', 6),
    pad('Conflicts', 10),
    pad('Comments', 9),
    pad('Score', 6),
  ].join('');

  console.log(chalk.bold(header));
  console.log(chalk.gray('─'.repeat(114)));

  for (const c of candidates) {
    const row = [
      pad(String(c.number), 6),
      pad(truncate(c.title, 50), 52),
      pad(truncate(c.author, 14), 16),
      pad(c.greptileScore !== null ? `${c.greptileScore}/5` : '-', 9),
      pad(colorCI(c.ciStatus), 6 + (colorCI(c.ciStatus).length - (c.ciStatus === 'unknown' ? 3 : 4))),
      pad(colorConflicts(c.hasConflicts), 10 + (colorConflicts(c.hasConflicts).length - (c.hasConflicts ? 3 : 2))),
      pad(String(c.humanComments), 9),
      colorScore(c.compositeScore),
    ].join('');
    console.log(row);
  }

  console.log(chalk.gray(`\n${candidates.length} PRs shown`));
}

function pad(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

export function displayPRDetail(detail: any): void {
  const { pr, scores, checks, reviews } = detail;

  console.log(chalk.bold(`\nPR #${pr.number}: ${pr.title}`));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(`Author:     ${pr.author}`);
  console.log(`Created:    ${pr.created_at}`);
  console.log(`Updated:    ${pr.updated_at}`);
  console.log(`Mergeable:  ${pr.mergeable === null ? 'unknown' : pr.mergeable ? chalk.green('yes') : chalk.red('no')}`);
  console.log(`State:      ${pr.mergeable_state ?? 'unknown'}`);

  if (pr.body) {
    console.log(chalk.bold('\nDescription:'));
    console.log(truncate(pr.body, 500));
  }

  if (scores.length > 0) {
    console.log(chalk.bold('\nGreptile Scores:'));
    for (const s of scores as any[]) {
      console.log(`  Score ${s.confidence_score}/5 (comment ${s.comment_id}, ${s.created_at})`);
    }
  }

  if (checks.length > 0) {
    console.log(chalk.bold('\nCheck Runs:'));
    for (const c of checks as any[]) {
      const status = c.conclusion ? `${c.status}/${c.conclusion}` : c.status;
      console.log(`  ${c.name}: ${status}`);
    }
  }

  if (reviews.length > 0) {
    console.log(chalk.bold('\nLLM Reviews:'));
    for (const r of reviews as any[]) {
      const review = JSON.parse(r.review_json);
      console.log(chalk.bold(`  [${r.model} v${r.prompt_version}] ${r.created_at}`));
      console.log(`  Recommendation: ${review.recommendation}`);
      console.log(`  Risk: ${review.risk_level}`);
      console.log(`  Summary: ${review.summary}`);
      if (review.reasoning) {
        console.log(`  Reasoning: ${review.reasoning}`);
      }
      console.log();
    }
  }
}
