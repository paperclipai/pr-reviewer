import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config';
import { getDb } from '../db/client';
import { sanitizePRContent, validateOutput } from './sanitizer';
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from './prompts';
import { listCandidates, FilterOptions } from '../scoring/filter';
import chalk from 'chalk';

const MODEL = 'claude-sonnet-4-20250514';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const config = loadConfig();
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for LLM reviews. Add it to .env');
  }
  _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return _client;
}

export interface ReviewResult {
  recommendation: string;
  reasoning: string;
  risk_level: string;
  summary: string;
}

export async function reviewPR(prNumber: number): Promise<ReviewResult | null> {
  const db = await getDb();

  const pr = await db.get('SELECT * FROM pull_requests WHERE number = ?', [prNumber]);
  if (!pr) {
    console.error(chalk.red(`PR #${prNumber} not found in database. Run 'sync' first.`));
    return null;
  }

  console.log(chalk.blue(`Reviewing PR #${prNumber}: ${pr.title}`));

  const { sections, boundaries } = sanitizePRContent({
    title: pr.title,
    body: pr.body,
  });

  const systemPrompt = buildSystemPrompt(boundaries);
  const userPrompt = buildUserPrompt(prNumber, sections);

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const rawOutput = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as any).text)
    .join('');

  const validation = validateOutput(rawOutput);
  if (!validation.valid) {
    console.warn(chalk.yellow(`Warning: Output validation flags for PR #${prNumber}:`));
    for (const flag of validation.flags) {
      console.warn(chalk.yellow(`  - ${flag}`));
    }
  }

  let review: ReviewResult;
  try {
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    review = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(chalk.red(`Failed to parse LLM response for PR #${prNumber}`));
    console.error(chalk.gray(rawOutput));
    return null;
  }

  await db.run(`
    INSERT INTO llm_reviews (pr_number, review_json, model, prompt_version)
    VALUES (?, ?, ?, ?)
  `, [prNumber, JSON.stringify(review), MODEL, PROMPT_VERSION]);

  console.log(chalk.green(`Review complete for PR #${prNumber}`));
  console.log(`  Recommendation: ${review.recommendation}`);
  console.log(`  Risk: ${review.risk_level}`);
  console.log(`  Summary: ${review.summary}`);

  return review;
}

export async function reviewTopCandidates(options: FilterOptions & { top: number }): Promise<void> {
  const candidates = await listCandidates({ ...options, limit: options.top });

  if (candidates.length === 0) {
    console.log(chalk.yellow('No candidates match the given filters.'));
    return;
  }

  console.log(chalk.blue(`Reviewing top ${candidates.length} candidates...`));

  for (let i = 0; i < candidates.length; i++) {
    console.log(chalk.gray(`\n[${i + 1}/${candidates.length}]`));
    await reviewPR(candidates[i].number);
  }

  console.log(chalk.green(`\nAll ${candidates.length} reviews complete.`));
}
