import type { DbClient } from '../db/types';
import { computeBaseScore, deriveCIStatus } from '../scoring';
import { githubAuthorProfilePath, normalizeGitHubHandle } from '../github/users';

export interface ThemeClusterSummary {
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

export async function getThemeOverview(db: DbClient): Promise<ThemeOverview> {
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

export async function getThemeClusterDetail(clusterId: string, db: DbClient): Promise<ThemeClusterDetail | null> {
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
