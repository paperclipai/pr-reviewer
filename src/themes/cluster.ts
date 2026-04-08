import { createHash, randomUUID } from 'node:crypto';
import type { DbClient } from '../db/types';
import { getDb } from '../db/client';
import { computeBaseScore, deriveCIStatus, type CIStatus } from '../scoring';
import { githubAuthorProfilePath, normalizeGitHubHandle } from '../github/users';

type ThemeStateFilter = 'open' | 'merged' | 'closed' | 'all';

interface ThemeSourceRow {
  number: number;
  title: string;
  body: string | null;
  author: string;
  author_handle: string | null;
  state: string;
  labels_json: string | null;
  created_at: string;
  updated_at: string;
  additions: number | null;
  deletions: number | null;
  mergeable: number | null;
  mergeable_state: string | null;
  greptile_score: number | null;
  total_checks: number;
  failed_checks: number;
  pending_checks: number;
  human_comments: number;
}

interface ThemeDocumentRow {
  prNumber: number;
  documentText: string;
  documentHash: string;
  updatedAt: string;
}

function chunk<T>(items: T[], size: number): T[][]
{
  const output: T[][] = [];
  for (let i = 0; i < items.length; i += size) output.push(items.slice(i, i + size));
  return output;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = String(value).replace(/'/g, "''");
  return `'${text}'`;
}

interface ThemeSourceDoc {
  number: number;
  title: string;
  body: string;
  author: string;
  authorHandle: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: string[];
  labels: Array<{ name: string; color?: string | null }>;
  reviewSummary: string | null;
  commentSummary: string | null;
  greptileScore: number | null;
  ciStatus: CIStatus;
  hasConflicts: boolean;
  humanComments: number;
  compositeScore: number;
  documentText: string;
  documentHash: string;
  tokenCounts: Map<string, number>;
  vector: Map<string, number>;
  avgSimilarity: number;
}

interface ThemeClusterNode {
  id: string;
  runId: string;
  parentClusterId: string | null;
  depth: number;
  slug: string;
  label: string;
  summary: string;
  itemCount: number;
  avgScore: number;
  centroidX: number;
  centroidY: number;
  keywords: string[];
  exemplarPrs: Array<{
    number: number;
    title: string;
    author: string;
    authorHandle: string;
    compositeScore: number;
    state: string;
  }>;
  memberIndexes: number[];
}

interface ThemeClusterSummary {
  id: string;
  label: string;
  summary: string;
  itemCount: number;
  depth: number;
  parentClusterId: string | null;
  centroidX: number;
  centroidY: number;
  keywords: string[];
  exemplarPrs: Array<{
    number: number;
    title: string;
    author: string;
    authorHandle: string;
    compositeScore: number;
    state: string;
  }>;
  hasChildren: boolean;
}

export interface ThemeClusterDetail {
  run: {
    id: string;
    algorithm: string;
    stateFilter: string;
    itemCount: number;
    createdAt: string;
  };
  cluster: ThemeClusterSummary;
  breadcrumbs: Array<{ id: string; label: string }>;
  children: ThemeClusterSummary[];
  prs: Array<{
    number: number;
    title: string;
    author: string;
    authorHandle: string;
    authorProfileUrl: string | null;
    state: string;
    compositeScore: number;
    createdAt: string;
    similarity: number;
    x: number;
    y: number;
  }>;
}

export interface ThemeOverview {
  run: {
    id: string;
    algorithm: string;
    stateFilter: string;
    itemCount: number;
    createdAt: string;
  } | null;
  clusters: ThemeClusterSummary[];
  levels: Array<{ depth: number; count: number }>;
}

export interface RebuildThemesOptions {
  state?: ThemeStateFilter;
}

const THEME_ALGORITHM = 'keyword-vector-hierarchy-v1';
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'from', 'this', 'have', 'into', 'your', 'their', 'will',
  'would', 'there', 'about', 'after', 'before', 'when', 'where', 'which', 'while', 'under',
  'over', 'between', 'through', 'using', 'used', 'more', 'less', 'some', 'many', 'much', 'just',
  'than', 'then', 'them', 'they', 'were', 'been', 'being', 'make', 'makes', 'made', 'into',
  'each', 'other', 'also', 'only', 'once', 'same', 'such', 'very', 'need', 'needs', 'want',
  'update', 'updates', 'updated', 'fix', 'fixes', 'fixed', 'add', 'adds', 'added', 'use', 'uses',
  'support', 'supports', 'supporting', 'change', 'changes', 'changed', 'improve', 'improves',
  'improved', 'refactor', 'refactors', 'refactored', 'cleanup', 'cleanups', 'issue', 'issues',
  'pull', 'request', 'requests', 'review', 'reviews', 'comment', 'comments', 'body', 'title',
  'file', 'files', 'path', 'paths', 'tests', 'test', 'pr', 'prs', 'data', 'code', 'work', 'repo',
  'paperclip', 'github', 'feat', 'chore', 'misc', 'open', 'merged', 'closed',
]);

const DOC_PATTERNS = [/^docs\//, /^doc\//, /\.md$/i, /^readme/i, /^changelog/i, /^changeset\//i];
const CI_PATTERNS = [/^\.github\//, /^\.circleci\//, /^ci\//, /^scripts\/ci\//, /workflow/i];
const DEP_PATTERNS = [/package-lock\.json$/i, /pnpm-lock\.yaml$/i, /yarn\.lock$/i, /cargo\.lock$/i, /poetry\.lock$/i, /^package\.json$/i, /^pnpm-workspace\.yaml$/i];
const TEST_PATTERNS = [/\.test\./i, /_test\./i, /\/__tests__\//i, /\.spec\./i, /_spec\./i, /^tests?\//i];

function parseLabels(input: string | null): Array<{ name: string; color?: string | null }> {
  if (!input) return [];
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanText(input: string | null | undefined, maxLength: number): string {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function titleize(input: string): string {
  return input
    .replace(/[-_]+/g, ' ')
    .split(/[ /]+/)
    .filter(Boolean)
    .map((part) => {
      const upper = part.toUpperCase();
      if (part.length <= 3 || /^[a-z]*\d+[a-z\d]*$/i.test(part)) return upper;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function hashText(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function tokenizeText(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function pushWeighted(map: Map<string, number>, token: string, weight: number): void {
  if (!token || weight <= 0) return;
  map.set(token, (map.get(token) ?? 0) + weight);
}

function addWordTokens(map: Map<string, number>, text: string, weight: number): void {
  for (const rawToken of tokenizeText(text)) {
    const pieces = rawToken.split(/[\/._-]+/).filter(Boolean);
    for (const piece of pieces) {
      if (piece.length < 3 || STOPWORDS.has(piece)) continue;
      pushWeighted(map, piece, weight);
    }
  }
}

function addPathTokens(map: Map<string, number>, filename: string): void {
  const normalized = filename.toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return;
  pushWeighted(map, `area:${parts[0]}`, 6);
  if (parts.length >= 2) {
    pushWeighted(map, `path:${parts[0]}/${parts[1]}`, 8);
  }
  const basename = parts[parts.length - 1];
  const extMatch = basename.match(/\.([a-z0-9]+)$/);
  if (extMatch) pushWeighted(map, `ext:${extMatch[1]}`, 3);
  for (const part of parts) {
    for (const piece of part.split(/[._-]+/).filter(Boolean)) {
      if (piece.length < 2 || STOPWORDS.has(piece)) continue;
      pushWeighted(map, piece, 2);
    }
  }
}

function detectPresetBucket(files: string[]): string | null {
  if (files.length === 0) return null;
  const docsOnly = files.every((file) => DOC_PATTERNS.some((pattern) => pattern.test(file)));
  if (docsOnly) return 'docs';
  const ciOnly = files.every((file) => CI_PATTERNS.some((pattern) => pattern.test(file)));
  if (ciOnly) return 'ci';
  const depOnly = files.every((file) => DEP_PATTERNS.some((pattern) => pattern.test(file)));
  if (depOnly) return 'deps';
  const testsOnly = files.every((file) => TEST_PATTERNS.some((pattern) => pattern.test(file)));
  if (testsOnly) return 'tests';
  return null;
}

function presetLabel(bucket: string): { label: string; summary: string; keywords: string[] } {
  switch (bucket) {
    case 'docs':
      return { label: 'Documentation', summary: 'Docs-heavy changes grouped separately for quick review.', keywords: ['Docs', 'Guides', 'Reference'] };
    case 'ci':
      return { label: 'CI & Automation', summary: 'Workflow, action, and automation changes grouped into one stream.', keywords: ['CI', 'Workflows', 'Automation'] };
    case 'deps':
      return { label: 'Dependencies', summary: 'Lockfile and package maintenance changes grouped as dependency work.', keywords: ['Dependencies', 'Lockfiles', 'Packages'] };
    case 'tests':
      return { label: 'Test Harness', summary: 'Test-only changes grouped into a dedicated validation lane.', keywords: ['Tests', 'Specs', 'Coverage'] };
    default:
      return { label: 'One-off Changes', summary: 'Low-overlap changes grouped as isolated or exploratory work.', keywords: ['One-offs', 'Exploration', 'Misc'] };
  }
}

function buildDocumentText(row: ThemeSourceRow, files: string[], reviewSummary: string | null, comments: string[]): string {
  const labels = parseLabels(row.labels_json).map((label) => label.name).join(', ');
  const parts = [
    `Title: ${cleanText(row.title, 220)}`,
    row.body ? `Body: ${cleanText(row.body, 900)}` : '',
    labels ? `Labels: ${labels}` : '',
    files.length ? `Files:\n- ${files.join('\n- ')}` : '',
    reviewSummary ? `Review summary: ${cleanText(reviewSummary, 240)}` : '',
    comments.length ? `Comments: ${comments.map((comment) => cleanText(comment, 180)).join(' | ')}` : '',
  ].filter(Boolean);
  return parts.join('\n\n');
}

function buildTokenCounts(doc: {
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  changedFiles: string[];
  reviewSummary: string | null;
  commentSummary: string | null;
}): Map<string, number> {
  const counts = new Map<string, number>();
  addWordTokens(counts, doc.title, 8);
  addWordTokens(counts, doc.body, 2);
  for (const label of doc.labels) addWordTokens(counts, label.name, 4);
  for (const filename of doc.changedFiles) addPathTokens(counts, filename);
  if (doc.reviewSummary) addWordTokens(counts, doc.reviewSummary, 3);
  if (doc.commentSummary) addWordTokens(counts, doc.commentSummary, 2);
  return counts;
}

function toSparseVector(tokenCounts: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const weighted: Array<[string, number]> = [];
  for (const [token, count] of tokenCounts.entries()) {
    const weight = count * (idf.get(token) ?? 1);
    if (weight > 0) weighted.push([token, weight]);
  }
  weighted.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const trimmed = weighted.slice(0, 80);
  const magnitude = Math.sqrt(trimmed.reduce((sum, [, weight]) => sum + weight * weight, 0)) || 1;
  return new Map(trimmed.map(([token, weight]) => [token, weight / magnitude]));
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let total = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [token, weight] of small.entries()) {
    total += weight * (large.get(token) ?? 0);
  }
  return total;
}

function buildSimilarityMatrix(docs: ThemeSourceDoc[]): number[][] {
  const matrix = Array.from({ length: docs.length }, () => Array(docs.length).fill(0));
  for (let i = 0; i < docs.length; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < docs.length; j++) {
      const sim = cosineSimilarity(docs[i].vector, docs[j].vector);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }
  for (let i = 0; i < docs.length; i++) {
    const row = matrix[i].filter((_, idx) => idx !== i);
    docs[i].avgSimilarity = row.length ? row.reduce((sum, value) => sum + value, 0) / row.length : 0;
  }
  return matrix;
}

function averageSimilarity(index: number, members: number[], matrix: number[][]): number {
  if (members.length === 0) return 0;
  let total = 0;
  for (const other of members) total += matrix[index][other];
  return total / members.length;
}

function clusterIndexes(indexes: number[], matrix: number[][], threshold: number): number[][] {
  if (indexes.length <= 1) return indexes.map((index) => [index]);
  const ordered = [...indexes];
  ordered.sort((a, b) => matrix[a].reduce((sum, value) => sum + value, 0) - matrix[b].reduce((sum, value) => sum + value, 0)).reverse();

  const clusters: number[][] = [];
  for (const index of ordered) {
    let bestCluster = -1;
    let bestScore = 0;
    for (let i = 0; i < clusters.length; i++) {
      const score = averageSimilarity(index, clusters[i], matrix);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = i;
      }
    }
    if (bestCluster >= 0 && bestScore >= threshold) clusters[bestCluster].push(index);
    else clusters.push([index]);
  }

  const merged: number[][] = [];
  const singletons: number[] = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) singletons.push(cluster[0]);
    else merged.push(cluster.sort((a, b) => a - b));
  }
  if (singletons.length === 1) merged.push(singletons);
  else if (singletons.length > 1) merged.push(singletons.sort((a, b) => a - b));

  return merged
    .map((cluster) => cluster.sort((a, b) => a - b))
    .sort((a, b) => b.length - a.length || a[0] - b[0]);
}

function hashNumber(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function layoutChildren(nodes: ThemeClusterNode[], parentX: number, parentY: number, radius: number): void {
  if (nodes.length === 0) return;
  if (nodes.length === 1) {
    nodes[0].centroidX = clamp(parentX, 8, 92);
    nodes[0].centroidY = clamp(parentY, 10, 90);
    return;
  }
  const ordered = [...nodes].sort((a, b) => a.label.localeCompare(b.label));
  ordered.forEach((node, index) => {
    const jitter = (hashNumber(node.id) % 11) / 100;
    const angle = -Math.PI / 2 + (index / ordered.length) * Math.PI * 2 + jitter;
    const spread = radius * (0.86 + jitter);
    node.centroidX = clamp(parentX + Math.cos(angle) * spread, 8, 92);
    node.centroidY = clamp(parentY + Math.sin(angle) * spread * 0.72, 10, 90);
  });
}

function prettifyKeyword(keyword: string): string {
  if (keyword.startsWith('path:')) return titleize(keyword.slice('path:'.length));
  if (keyword.startsWith('area:')) return titleize(keyword.slice('area:'.length));
  if (keyword.startsWith('ext:')) return `${keyword.slice('ext:'.length).toUpperCase()} files`;
  return titleize(keyword);
}

function collectKeywordStats(docs: ThemeSourceDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    for (const [token, count] of doc.tokenCounts.entries()) {
      if (token.startsWith('ext:')) continue;
      counts.set(token, (counts.get(token) ?? 0) + count);
    }
  }
  return counts;
}

function deriveKeywords(docs: ThemeSourceDoc[], limit: number = 4): string[] {
  const stats = [...collectKeywordStats(docs).entries()]
    .filter(([token]) => !STOPWORDS.has(token))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return stats.slice(0, limit).map(([token]) => prettifyKeyword(token));
}

function deriveLabel(docs: ThemeSourceDoc[], fallback: string): string {
  const stats = [...collectKeywordStats(docs).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const prefix = stats.find(([token]) => token.startsWith('path:') || token.startsWith('area:'));
  if (prefix) return prettifyKeyword(prefix[0]);
  const words = stats.filter(([token]) => !token.includes(':')).slice(0, 2).map(([token]) => titleize(token));
  if (words.length > 0) return words.join(' / ');
  return fallback;
}

function deriveSummary(label: string, docs: ThemeSourceDoc[], keywords: string[]): string {
  const states = Array.from(new Set(docs.map((doc) => doc.state))).sort();
  const stateSuffix = states.length === 1 ? `${states[0]} PRs` : 'PRs';
  const keywordText = keywords.slice(0, 3).join(', ');
  return `${docs.length} ${stateSuffix} orbiting ${label.toLowerCase()}${keywordText ? ` around ${keywordText.toLowerCase()}` : ''}.`;
}

function buildExemplars(indexes: number[], docs: ThemeSourceDoc[], matrix: number[][]): ThemeClusterNode['exemplarPrs'] {
  const scored = indexes.map((index) => ({
    doc: docs[index],
    score: averageSimilarity(index, indexes.filter((candidate) => candidate !== index), matrix) + docs[index].compositeScore / 500,
  }));
  scored.sort((a, b) => b.score - a.score || b.doc.compositeScore - a.doc.compositeScore || a.doc.number - b.doc.number);
  return scored.slice(0, 3).map(({ doc }) => ({
    number: doc.number,
    title: doc.title,
    author: doc.author,
    authorHandle: doc.authorHandle,
    compositeScore: doc.compositeScore,
    state: doc.state,
  }));
}

function createNode(args: {
  runId: string;
  parentClusterId: string | null;
  depth: number;
  label: string;
  summary: string;
  keywords: string[];
  memberIndexes: number[];
  docs: ThemeSourceDoc[];
  matrix: number[][];
  slugSeed: string;
}): ThemeClusterNode {
  const exemplars = buildExemplars(args.memberIndexes, args.docs, args.matrix);
  const avgScore = Math.round(args.memberIndexes.reduce((sum, index) => sum + args.docs[index].compositeScore, 0) / Math.max(1, args.memberIndexes.length));
  const slug = `${args.depth}-${hashText(`${args.slugSeed}-${args.label}`).slice(0, 8)}`;
  return {
    id: `${args.runId}-${slug}`,
    runId: args.runId,
    parentClusterId: args.parentClusterId,
    depth: args.depth,
    slug,
    label: args.label,
    summary: args.summary,
    itemCount: args.memberIndexes.length,
    avgScore,
    centroidX: 50,
    centroidY: 50,
    keywords: args.keywords,
    exemplarPrs: exemplars,
    memberIndexes: [...args.memberIndexes].sort((a, b) => a - b),
  };
}

function buildHierarchy(runId: string, docs: ThemeSourceDoc[], matrix: number[][]): ThemeClusterNode[] {
  const nodes: ThemeClusterNode[] = [];
  const presetGroups = new Map<string, number[]>();
  const semanticIndexes: number[] = [];

  docs.forEach((doc, index) => {
    const bucket = detectPresetBucket(doc.changedFiles);
    if (bucket) {
      const group = presetGroups.get(bucket) ?? [];
      group.push(index);
      presetGroups.set(bucket, group);
    } else {
      semanticIndexes.push(index);
    }
  });

  const rootNodes: ThemeClusterNode[] = [];
  for (const [bucket, indexes] of [...presetGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const info = presetLabel(bucket);
    rootNodes.push(createNode({
      runId,
      parentClusterId: null,
      depth: 0,
      label: info.label,
      summary: info.summary,
      keywords: info.keywords,
      memberIndexes: indexes,
      docs,
      matrix,
      slugSeed: bucket,
    }));
  }

  if (semanticIndexes.length > 0) {
    const grouped = clusterIndexes(semanticIndexes, matrix, 0.16);
    grouped.forEach((indexes, clusterIdx) => {
      const clusterDocs = indexes.map((index) => docs[index]);
      const fallback = indexes.length === 1 ? titleize(clusterDocs[0].title.split(/\s+/).slice(0, 3).join(' ')) : `Theme ${clusterIdx + 1}`;
      const keywords = deriveKeywords(clusterDocs);
      const label = deriveLabel(clusterDocs, fallback);
      rootNodes.push(createNode({
        runId,
        parentClusterId: null,
        depth: 0,
        label,
        summary: deriveSummary(label, clusterDocs, keywords),
        keywords,
        memberIndexes: indexes,
        docs,
        matrix,
        slugSeed: `root-${clusterIdx}`,
      }));
    });
  }

  layoutChildren(rootNodes, 50, 50, 34);
  nodes.push(...rootNodes);

  const subclusterThresholds = [0.26, 0.38];
  let currentParents = rootNodes;
  subclusterThresholds.forEach((threshold, depthOffset) => {
    const nextParents: ThemeClusterNode[] = [];
    for (const parent of currentParents) {
      if (parent.itemCount < 4) continue;
      const childGroups = clusterIndexes(parent.memberIndexes, matrix, threshold).filter((group) => group.length > 1);
      if (childGroups.length < 2) continue;
      const children = childGroups.map((indexes, childIdx) => {
        const childDocs = indexes.map((index) => docs[index]);
        const keywords = deriveKeywords(childDocs);
        const label = deriveLabel(childDocs, `${parent.label} ${childIdx + 1}`);
        return createNode({
          runId,
          parentClusterId: parent.id,
          depth: parent.depth + 1,
          label,
          summary: deriveSummary(label, childDocs, keywords),
          keywords,
          memberIndexes: indexes,
          docs,
          matrix,
          slugSeed: `${parent.id}-${childIdx}`,
        });
      });
      layoutChildren(children, parent.centroidX, parent.centroidY, 14 - depthOffset * 3.5);
      nodes.push(...children);
      nextParents.push(...children);
    }
    currentParents = nextParents;
  });

  return nodes;
}

async function loadThemeSourceDocs(db: DbClient, state: ThemeStateFilter): Promise<ThemeSourceDoc[]> {
  const params: any[] = [];
  const where = state === 'all' ? '' : 'WHERE pr.state = ?';
  const commentWhere = state === 'all' ? `WHERE pc.author NOT LIKE '%[bot]'` : `WHERE pr.state = ? AND pc.author NOT LIKE '%[bot]'`;
  if (state !== 'all') params.push(state);

  const rows = await db.all<ThemeSourceRow>(`
    SELECT
      pr.number, pr.title, pr.body, pr.author, COALESCE(pr.author_handle, LOWER(pr.author)) as author_handle,
      pr.state, pr.labels_json, pr.created_at, pr.updated_at, pr.additions, pr.deletions,
      pr.mergeable, pr.mergeable_state,
      (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks,
      (SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number AND pc.author NOT LIKE '%[bot]') as human_comments
    FROM pull_requests pr
    ${where}
    ORDER BY pr.number DESC
  `, params);

  const files = await db.all<{ pr_number: number; filename: string }>(`
    SELECT pf.pr_number, pf.filename
    FROM pr_files pf
    JOIN pull_requests pr ON pr.number = pf.pr_number
    ${where}
    ORDER BY pf.pr_number ASC, pf.filename ASC
  `, params);

  const comments = await db.all<{ pr_number: number; body: string; created_at: string }>(`
    SELECT pc.pr_number, pc.body, pc.created_at
    FROM pr_comments pc
    JOIN pull_requests pr ON pr.number = pc.pr_number
    ${commentWhere}
    ORDER BY pc.pr_number ASC, pc.created_at DESC, pc.comment_id DESC
  `, params);

  const reviews = await db.all<{ pr_number: number; review_json: string; created_at: string }>(`
    SELECT lr.pr_number, lr.review_json, lr.created_at
    FROM llm_reviews lr
    JOIN pull_requests pr ON pr.number = lr.pr_number
    ${where}
    ORDER BY lr.pr_number ASC, lr.created_at DESC
  `, params);

  const filesByPr = new Map<number, string[]>();
  for (const file of files) {
    const bucket = filesByPr.get(file.pr_number) ?? [];
    bucket.push(file.filename);
    filesByPr.set(file.pr_number, bucket);
  }

  const commentsByPr = new Map<number, string[]>();
  for (const comment of comments) {
    const bucket = commentsByPr.get(comment.pr_number) ?? [];
    if (bucket.length < 3) bucket.push(comment.body);
    commentsByPr.set(comment.pr_number, bucket);
  }

  const reviewByPr = new Map<number, string>();
  for (const review of reviews) {
    if (reviewByPr.has(review.pr_number)) continue;
    try {
      const parsed = JSON.parse(review.review_json);
      const summary = cleanText(parsed?.summary ?? parsed?.reasoning ?? '', 260);
      if (summary) reviewByPr.set(review.pr_number, summary);
    } catch {
      continue;
    }
  }

  const docs = rows.map((row) => {
    const changedFiles = filesByPr.get(row.number) ?? [];
    const reviewSummary = reviewByPr.get(row.number) ?? null;
    const commentBodies = commentsByPr.get(row.number) ?? [];
    const documentText = buildDocumentText(row, changedFiles, reviewSummary, commentBodies);
    const documentHash = hashText(documentText);
    const ciStatus = deriveCIStatus(row.total_checks, row.failed_checks, row.pending_checks);
    const hasConflicts = row.mergeable === 0 || row.mergeable_state === 'dirty';
    const tokenCounts = buildTokenCounts({
      title: row.title,
      body: row.body ?? '',
      labels: parseLabels(row.labels_json),
      changedFiles,
      reviewSummary,
      commentSummary: commentBodies.map((body) => cleanText(body, 180)).join(' | ') || null,
    });
    return {
      number: row.number,
      title: row.title,
      body: row.body ?? '',
      author: row.author,
      authorHandle: normalizeGitHubHandle(row.author_handle ?? row.author),
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      additions: row.additions ?? 0,
      deletions: row.deletions ?? 0,
      changedFiles,
      labels: parseLabels(row.labels_json),
      reviewSummary,
      commentSummary: commentBodies.map((body) => cleanText(body, 180)).join(' | ') || null,
      greptileScore: row.greptile_score,
      ciStatus,
      hasConflicts,
      humanComments: row.human_comments,
      compositeScore: computeBaseScore(row.greptile_score, ciStatus, hasConflicts, row.human_comments, row.additions ?? 0, row.deletions ?? 0),
      documentText,
      documentHash,
      tokenCounts,
      vector: new Map<string, number>(),
      avgSimilarity: 0,
    } satisfies ThemeSourceDoc;
  });

  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc.tokenCounts.keys())) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  const totalDocs = Math.max(1, docs.length);
  for (const [token, frequency] of documentFrequency.entries()) {
    idf.set(token, Math.log((1 + totalDocs) / (1 + frequency)) + 1);
  }
  for (const doc of docs) {
    doc.vector = toSparseVector(doc.tokenCounts, idf);
  }

  return docs;
}

function membershipCoordinates(cluster: ThemeClusterNode, indexes: number[], docs: ThemeSourceDoc[], matrix: number[][]): Array<{
  prNumber: number;
  x: number;
  y: number;
  similarity: number;
  rank: number;
}> {
  const scored = indexes.map((index) => ({
    index,
    similarity: averageSimilarity(index, indexes.filter((candidate) => candidate !== index), matrix) || docs[index].avgSimilarity || 0,
  }));
  scored.sort((a, b) => b.similarity - a.similarity || docs[b.index].compositeScore - docs[a.index].compositeScore || docs[a.index].number - docs[b.index].number);
  return scored.map((entry, order) => {
    const ring = 1 + Math.floor(order / 6);
    const slot = order % 6;
    const angle = ((slot / 6) * Math.PI * 2) + (hashNumber(`${cluster.id}-${docs[entry.index].number}`) % 7) / 20;
    const radius = 2.6 + ring * 2.9;
    return {
      prNumber: docs[entry.index].number,
      x: clamp(cluster.centroidX + Math.cos(angle) * radius, 6, 94),
      y: clamp(cluster.centroidY + Math.sin(angle) * radius * 0.85, 8, 92),
      similarity: Math.round(entry.similarity * 1000) / 1000,
      rank: order + 1,
    };
  });
}

export async function rebuildThemeClusters(options: RebuildThemesOptions = {}, inputDb?: DbClient): Promise<{ runId: string; clusterCount: number; itemCount: number }> {
  const db = inputDb ?? await getDb();
  const state = options.state ?? 'open';
  const docs = await loadThemeSourceDocs(db, state);
  const matrix = buildSimilarityMatrix(docs);
  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const nodes = buildHierarchy(runId, docs, matrix);

  const statements: string[] = [
    `INSERT INTO theme_runs (id, algorithm, state_filter, item_count, created_at)
     VALUES (${sqlLiteral(runId)}, ${sqlLiteral(THEME_ALGORITHM)}, ${sqlLiteral(state)}, ${sqlLiteral(docs.length)}, ${sqlLiteral(createdAt)});`,
  ];

  const documentRows: ThemeDocumentRow[] = docs.map((doc) => ({
    prNumber: doc.number,
    documentText: doc.documentText,
    documentHash: doc.documentHash,
    updatedAt: doc.updatedAt,
  }));
  for (const group of chunk(documentRows, 5)) {
    statements.push(`
      INSERT INTO theme_pr_documents (pr_number, document_text, document_hash, updated_at)
      VALUES ${group.map((doc) => `(${sqlLiteral(doc.prNumber)}, ${sqlLiteral(doc.documentText)}, ${sqlLiteral(doc.documentHash)}, ${sqlLiteral(doc.updatedAt)})`).join(', ')}
      ON CONFLICT(pr_number) DO UPDATE SET
        document_text = excluded.document_text,
        document_hash = excluded.document_hash,
        updated_at = excluded.updated_at;
    `);
  }

  for (const group of chunk(nodes, 25)) {
    statements.push(`
      INSERT INTO theme_clusters (
        id, run_id, parent_cluster_id, depth, slug, label, summary,
        item_count, avg_score, centroid_x, centroid_y, keywords_json, exemplar_prs_json
      ) VALUES ${group.map((node) => `(
        ${sqlLiteral(node.id)},
        ${sqlLiteral(node.runId)},
        ${sqlLiteral(node.parentClusterId)},
        ${sqlLiteral(node.depth)},
        ${sqlLiteral(node.slug)},
        ${sqlLiteral(node.label)},
        ${sqlLiteral(node.summary)},
        ${sqlLiteral(node.itemCount)},
        ${sqlLiteral(node.avgScore)},
        ${sqlLiteral(node.centroidX)},
        ${sqlLiteral(node.centroidY)},
        ${sqlLiteral(JSON.stringify(node.keywords))},
        ${sqlLiteral(JSON.stringify(node.exemplarPrs))}
      )`).join(', ')};
    `);
  }

  const membershipRows = nodes.flatMap((node) =>
    membershipCoordinates(node, node.memberIndexes, docs, matrix).map((membership) => ({
      runId,
      clusterId: node.id,
      prNumber: membership.prNumber,
      depth: node.depth,
      similarity: membership.similarity,
      x: membership.x,
      y: membership.y,
      rank: membership.rank,
    })),
  );

  for (const group of chunk(membershipRows, 80)) {
    statements.push(`
      INSERT INTO theme_cluster_memberships (run_id, cluster_id, pr_number, depth, similarity, x, y, rank)
      VALUES ${group.map((row) => `(
        ${sqlLiteral(row.runId)},
        ${sqlLiteral(row.clusterId)},
        ${sqlLiteral(row.prNumber)},
        ${sqlLiteral(row.depth)},
        ${sqlLiteral(row.similarity)},
        ${sqlLiteral(row.x)},
        ${sqlLiteral(row.y)},
        ${sqlLiteral(row.rank)}
      )`).join(', ')};
    `);
  }

  for (const statement of statements) {
    await db.exec(statement);
  }
  return { runId, clusterCount: nodes.length, itemCount: docs.length };
}

async function getLatestRun(db: DbClient) {
  return await db.get<{
    id: string;
    algorithm: string;
    state_filter: string;
    item_count: number;
    created_at: string;
  }>(`SELECT id, algorithm, state_filter, item_count, created_at FROM theme_runs ORDER BY created_at DESC LIMIT 1`);
}

function parseClusterRow(row: any): ThemeClusterSummary {
  let keywords: string[] = [];
  let exemplarPrs: ThemeClusterSummary['exemplarPrs'] = [];
  try { keywords = JSON.parse(row.keywords_json || '[]'); } catch {}
  try { exemplarPrs = JSON.parse(row.exemplar_prs_json || '[]'); } catch {}
  return {
    id: row.id,
    label: row.label,
    summary: row.summary,
    itemCount: Number(row.item_count ?? 0),
    depth: Number(row.depth ?? 0),
    parentClusterId: row.parent_cluster_id ?? null,
    centroidX: Number(row.centroid_x ?? 50),
    centroidY: Number(row.centroid_y ?? 50),
    keywords,
    exemplarPrs,
    hasChildren: Number(row.child_count ?? 0) > 0,
  };
}

export async function getThemeOverview(inputDb?: DbClient): Promise<ThemeOverview> {
  const db = inputDb ?? await getDb();
  const run = await getLatestRun(db);
  if (!run) return { run: null, clusters: [], levels: [] };

  const [clusters, levels] = await Promise.all([
    db.all<any>(`
      SELECT c.*,
        (SELECT COUNT(*) FROM theme_clusters child WHERE child.parent_cluster_id = c.id) as child_count
      FROM theme_clusters c
      WHERE c.run_id = ? AND c.parent_cluster_id IS NULL
      ORDER BY c.item_count DESC, c.label ASC
    `, [run.id]),
    db.all<{ depth: number; count: number }>(`
      SELECT depth, COUNT(*) as count
      FROM theme_clusters
      WHERE run_id = ?
      GROUP BY depth
      ORDER BY depth ASC
    `, [run.id]),
  ]);

  return {
    run: {
      id: run.id,
      algorithm: run.algorithm,
      stateFilter: run.state_filter,
      itemCount: Number(run.item_count ?? 0),
      createdAt: run.created_at,
    },
    clusters: clusters.map(parseClusterRow),
    levels: levels.map((level) => ({ depth: Number(level.depth), count: Number(level.count) })),
  };
}

export async function getThemeClusterDetail(clusterId: string, inputDb?: DbClient): Promise<ThemeClusterDetail | null> {
  const db = inputDb ?? await getDb();
  const cluster = await db.get<any>(`
    SELECT c.*,
      (SELECT COUNT(*) FROM theme_clusters child WHERE child.parent_cluster_id = c.id) as child_count
    FROM theme_clusters c
    WHERE c.id = ?
  `, [clusterId]);
  if (!cluster) return null;

  const run = await db.get<any>(`SELECT id, algorithm, state_filter, item_count, created_at FROM theme_runs WHERE id = ?`, [cluster.run_id]);
  if (!run) return null;

  const children = await db.all<any>(`
    SELECT c.*,
      (SELECT COUNT(*) FROM theme_clusters child WHERE child.parent_cluster_id = c.id) as child_count
    FROM theme_clusters c
    WHERE c.parent_cluster_id = ?
    ORDER BY c.item_count DESC, c.label ASC
  `, [clusterId]);

  const memberships = await db.all<any>(`
    SELECT
      m.pr_number,
      m.similarity,
      m.x,
      m.y,
      pr.title,
      pr.author,
      COALESCE(pr.author_handle, LOWER(pr.author)) as author_handle,
      pr.state,
      pr.created_at,
      pr.additions,
      pr.deletions,
      pr.mergeable,
      pr.mergeable_state,
      (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
      (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks,
      (SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number AND pc.author NOT LIKE '%[bot]') as human_comments
    FROM theme_cluster_memberships m
    JOIN pull_requests pr ON pr.number = m.pr_number
    WHERE m.cluster_id = ?
    ORDER BY m.rank ASC, pr.number DESC
    LIMIT 36
  `, [clusterId]);

  const breadcrumbs: Array<{ id: string; label: string }> = [];
  let currentParentId: string | null = cluster.parent_cluster_id ?? null;
  while (currentParentId) {
    const parent = await db.get<{ id: string; label: string; parent_cluster_id: string | null }>(
      `SELECT id, label, parent_cluster_id FROM theme_clusters WHERE id = ?`,
      [currentParentId],
    );
    if (!parent) break;
    breadcrumbs.unshift({ id: parent.id, label: parent.label });
    currentParentId = parent.parent_cluster_id;
  }

  return {
    run: {
      id: run.id,
      algorithm: run.algorithm,
      stateFilter: run.state_filter,
      itemCount: Number(run.item_count ?? 0),
      createdAt: run.created_at,
    },
    cluster: parseClusterRow(cluster),
    breadcrumbs,
    children: children.map(parseClusterRow),
    prs: memberships.map((row) => {
      const ciStatus = deriveCIStatus(row.total_checks, row.failed_checks, row.pending_checks);
      const hasConflicts = row.mergeable === 0 || row.mergeable_state === 'dirty';
      return {
        number: row.pr_number,
        title: row.title,
        author: row.author,
        authorHandle: normalizeGitHubHandle(row.author_handle ?? row.author),
        authorProfileUrl: githubAuthorProfilePath(row.author_handle ?? row.author),
        state: row.state,
        compositeScore: computeBaseScore(row.greptile_score, ciStatus, hasConflicts, row.human_comments, row.additions ?? 0, row.deletions ?? 0),
        createdAt: row.created_at,
        similarity: Number(row.similarity ?? 0),
        x: Number(row.x ?? 50),
        y: Number(row.y ?? 50),
      };
    }),
  };
}
