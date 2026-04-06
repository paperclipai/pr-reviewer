import { Hono } from 'hono';
import type { DbClient } from '../db/types';
import {
  DEFAULT_CONSENSUS_CAP,
  DEFAULT_DISCOVERY_CAP,
  consensusProgress,
  clipsPhase,
  deriveTasteBadges,
  formatPercent,
  isEligibleVerifiedType,
} from '../clips';
import {
  createDemoSession,
  destroySession,
  getSessionUser,
  setAbsoluteAllocation,
  settleResolvedLots,
  type SessionUserRow,
} from '../clip-store';

export type { DbClient };

const SESSION_COOKIE = 'pr_reviewer_session';

type CIStatus = 'passing' | 'failing' | 'pending' | 'unknown';

function deriveCIStatus(totalChecks: number, failedChecks: number, pendingChecks: number): CIStatus {
  if (totalChecks === 0) return 'unknown';
  if (failedChecks > 0) return 'failing';
  if (pendingChecks > 0) return 'pending';
  return 'passing';
}

function locScore(additions: number, deletions: number): number {
  const totalLoc = additions + deletions;
  if (totalLoc === 0) return 15;
  return Math.max(0, Math.round(15 - 3 * Math.log10(totalLoc)));
}

function computeCompositeScore(
  greptileScore: number | null,
  ciStatus: CIStatus,
  hasConflicts: boolean,
  humanComments: number,
  additions: number = 0,
  deletions: number = 0,
): number {
  let score = 0;
  if (greptileScore !== null) score += greptileScore * 8;
  switch (ciStatus) {
    case 'passing': score += 25; break;
    case 'pending': score += 12; break;
    case 'unknown': score += 8; break;
    case 'failing': score += 0; break;
  }
  score += hasConflicts ? -15 : 15;
  if (humanComments >= 2) score += 20;
  else if (humanComments === 1) score += 10;
  score += locScore(additions, deletions);
  return Math.max(0, Math.min(115, score));
}

function scoreBreakdown(
  greptileScore: number | null,
  ciStatus: CIStatus,
  hasConflicts: boolean,
  humanComments: number,
  additions: number = 0,
  deletions: number = 0,
) {
  const greptile = greptileScore !== null ? greptileScore * 8 : 0;
  let ci = 0;
  switch (ciStatus) {
    case 'passing': ci = 25; break;
    case 'pending': ci = 12; break;
    case 'unknown': ci = 8; break;
  }
  const conflicts = hasConflicts ? -15 : 15;
  let comments = 0;
  if (humanComments >= 2) comments = 20;
  else if (humanComments === 1) comments = 10;
  const loc = locScore(additions, deletions);
  return {
    total: Math.max(0, Math.min(115, greptile + ci + conflicts + comments + loc)),
    greptile: { value: greptile, max: 40, input: greptileScore },
    ci: { value: ci, max: 25, input: ciStatus },
    conflicts: { value: conflicts, range: '-15 to +15', input: hasConflicts },
    humanComments: { value: comments, max: 20, input: humanComments },
    loc: { value: loc, max: 15, input: additions + deletions, note: 'Fewer changes = higher score' },
  };
}

function parseCookie(header: string | undefined | null, name: string): string | null {
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

function serializeCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function excerpt(text: string | null | undefined, maxLength: number = 180): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function safeJson(value: string | null | undefined): any[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

const PR_SELECT = `
  SELECT
    pr.number,
    pr.title,
    pr.body,
    pr.author,
    pr.head_sha,
    pr.mergeable,
    pr.mergeable_state,
    pr.state,
    pr.labels_json,
    pr.additions,
    pr.deletions,
    pr.changed_files,
    pr.created_at,
    pr.updated_at,
    (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks,
    (SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number AND pc.author NOT LIKE '%[bot]') as human_comments,
    MAX(pr.updated_at, COALESCE((SELECT MAX(pc.created_at) FROM pr_comments pc WHERE pc.pr_number = pr.number), pr.updated_at)) as last_activity,
    COALESCE((SELECT SUM(lot.clips_remaining) FROM clip_allocation_lots lot WHERE lot.pr_number = pr.number AND lot.status = 'open'), 0) as total_clips,
    COALESCE((SELECT COUNT(DISTINCT lot.user_id) FROM clip_allocation_lots lot WHERE lot.pr_number = pr.number AND lot.status = 'open'), 0) as voter_count
  FROM pull_requests pr
`;

async function loadViewer(db: DbClient, cookieHeader: string | undefined): Promise<SessionUserRow | null> {
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  return await getSessionUser(db, token);
}

function buildCandidate(row: any, viewerAllocation: number = 0) {
  const ciStatus = deriveCIStatus(row.total_checks, row.failed_checks, row.pending_checks);
  const hasConflicts = row.mergeable === 0 || row.mergeable_state === 'dirty';
  const totalClips = Number(row.total_clips ?? 0);
  return {
    number: row.number,
    title: row.title,
    excerpt: excerpt(row.body),
    author: row.author,
    state: row.state,
    labels: safeJson(row.labels_json || '[]'),
    greptileScore: row.greptile_score,
    ciStatus,
    hasConflicts,
    humanComments: row.human_comments,
    compositeScore: computeCompositeScore(row.greptile_score, ciStatus, hasConflicts, row.human_comments, row.additions ?? 0, row.deletions ?? 0),
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
    changedFiles: row.changed_files ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivity: row.last_activity,
    totalClips,
    voterCount: Number(row.voter_count ?? 0),
    phase: clipsPhase(totalClips, DEFAULT_DISCOVERY_CAP, DEFAULT_CONSENSUS_CAP),
    consensusProgressPct: formatPercent(consensusProgress(totalClips, DEFAULT_CONSENSUS_CAP)),
    nextClipBonusPct: formatPercent(Math.max(0, Math.min(1, totalClips < DEFAULT_CONSENSUS_CAP ? (totalClips < DEFAULT_DISCOVERY_CAP ? 1 : (DEFAULT_CONSENSUS_CAP - (totalClips + 1)) / (DEFAULT_CONSENSUS_CAP - DEFAULT_DISCOVERY_CAP)) : 0))),
    viewerAllocation,
  };
}

async function getViewerAllocation(db: DbClient, userId: string, prNumber: number): Promise<number> {
  const row = await db.get<{ total: number }>(
    `SELECT COALESCE(SUM(clips_remaining), 0) as total
     FROM clip_allocation_lots
     WHERE user_id = ? AND pr_number = ? AND status = 'open'`,
    [userId, prNumber],
  );
  return Number(row?.total ?? 0);
}

async function buildSessionPayload(db: DbClient, viewer: SessionUserRow | null) {
  if (!viewer) {
    return {
      authenticated: false,
      authMode: 'demo',
      discoveryCap: DEFAULT_DISCOVERY_CAP,
      consensusCap: DEFAULT_CONSENSUS_CAP,
    };
  }

  const mergedRow = await db.get<{ count: number; avg_position: number | null }>(`
    SELECT COUNT(*) as count, AVG(position_start) as avg_position
    FROM clip_allocation_lots
    WHERE user_id = ? AND outcome = 'merged'
  `, [viewer.id]);
  const activeRow = await db.get<{ count: number }>(
    `SELECT COUNT(DISTINCT pr_number) as count FROM clip_allocation_lots WHERE user_id = ? AND status = 'open'`,
    [viewer.id],
  );

  return {
    authenticated: true,
    authMode: 'demo',
    discoveryCap: DEFAULT_DISCOVERY_CAP,
    consensusCap: DEFAULT_CONSENSUS_CAP,
    user: {
      id: viewer.id,
      handle: viewer.handle,
      displayName: viewer.display_name,
      avatarUrl: viewer.avatar_url,
      verifiedType: viewer.verified_type,
      subscriptionType: viewer.subscription_type,
      clipsBalance: viewer.clips_balance,
      totalClipsWon: viewer.total_clips_won,
      xUrl: `https://x.com/${viewer.handle}`,
      eligible: isEligibleVerifiedType(viewer.verified_type),
      badges: deriveTasteBadges({
        mergedCount: Number(mergedRow?.count ?? 0),
        totalWon: viewer.total_clips_won,
        averageEntryPosition: mergedRow && mergedRow.avg_position !== null ? Number(mergedRow.avg_position) : null,
        activeAllocations: Number(activeRow?.count ?? 0),
      }),
    },
  };
}

async function safeSearch<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fallback();
  }
}

/** Create API routes with an injected DB client — no Node.js imports */
export function createRoutes(getDb: () => Promise<DbClient>): Hono {
  const api = new Hono();

  api.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

  api.get('/session', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const viewer = await loadViewer(db, c.req.header('cookie'));
    return c.json(await buildSessionPayload(db, viewer));
  });

  api.post('/auth/demo-login', async (c) => {
    const db = await getDb();
    const body = await c.req.json().catch(() => ({} as any));
    const { token, user } = await createDemoSession(db, {
      handle: String(body.handle || ''),
      displayName: body.displayName ? String(body.displayName) : null,
      verifiedType: body.verifiedType ? String(body.verifiedType) : 'blue',
      subscriptionType: body.subscriptionType ? String(body.subscriptionType) : 'premium',
      avatarUrl: body.avatarUrl ? String(body.avatarUrl) : null,
    });
    c.header('Set-Cookie', serializeCookie(SESSION_COOKIE, token, 60 * 60 * 24 * 30));
    return c.json(await buildSessionPayload(db, user));
  });

  api.get('/auth/x/start', async (c) => {
    return c.json({
      error: 'X OAuth is not configured in this deployment. Use demo login locally, or wire real credentials in a follow-up.',
    }, 501);
  });

  api.post('/auth/logout', async (c) => {
    const db = await getDb();
    const token = parseCookie(c.req.header('cookie'), SESSION_COOKIE);
    await destroySession(db, token);
    c.header('Set-Cookie', clearCookie(SESSION_COOKIE));
    return c.json({ ok: true });
  });

  api.get('/leaderboard', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const rows = await db.all(`${PR_SELECT} WHERE pr.state = 'open' ORDER BY total_clips DESC, voter_count DESC, pr.updated_at DESC LIMIT 24`);
    return c.json(rows.map((row) => buildCandidate(row)));
  });

  api.get('/voters', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const rows = await db.all<any>(`
      SELECT
        u.handle,
        u.display_name,
        u.avatar_url,
        u.verified_type,
        u.total_clips_won,
        COUNT(DISTINCT CASE WHEN lot.outcome = 'merged' THEN lot.pr_number END) as merged_picks,
        AVG(CASE WHEN lot.outcome = 'merged' THEN lot.position_start END) as avg_entry_position
      FROM users u
      LEFT JOIN clip_allocation_lots lot ON lot.user_id = u.id
      GROUP BY u.id
      ORDER BY u.total_clips_won DESC, merged_picks DESC, u.handle ASC
      LIMIT 30
    `);
    return c.json(rows.map((row) => ({
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      verifiedType: row.verified_type,
      totalClipsWon: Number(row.total_clips_won ?? 0),
      mergedPicks: Number(row.merged_picks ?? 0),
      averageEntryPosition: row.avg_entry_position === null ? null : Number(row.avg_entry_position),
      profileUrl: `#/profile/${row.handle}`,
    })));
  });

  api.get('/prs', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const viewer = await loadViewer(db, c.req.header('cookie'));

    const minScore = c.req.query('minScore');
    const ci = c.req.query('ci');
    const noConflicts = c.req.query('noConflicts') === 'true';
    const limitStr = c.req.query('limit');
    const state = c.req.query('state') || 'open';
    const author = c.req.query('author');
    const label = c.req.query('label');
    const sort = c.req.query('sort') || 'clips';

    const conditions: string[] = [];
    const params: any[] = [];
    if (state !== 'all') {
      conditions.push('pr.state = ?');
      params.push(state);
    }
    if (author) {
      conditions.push('pr.author = ?');
      params.push(author);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all(`${PR_SELECT} ${whereClause} ORDER BY pr.number DESC`, params);

    let candidates = await Promise.all(rows.map(async (row) => {
      const viewerAllocation = viewer ? await getViewerAllocation(db, viewer.id, row.number) : 0;
      return buildCandidate(row, viewerAllocation);
    }));

    if (minScore) candidates = candidates.filter((r) => r.greptileScore !== null && r.greptileScore >= parseInt(minScore, 10));
    if (ci && ['passing', 'failing', 'pending'].includes(ci)) candidates = candidates.filter((r) => r.ciStatus === ci);
    if (noConflicts) candidates = candidates.filter((r) => !r.hasConflicts);
    if (label) {
      const labelLower = label.toLowerCase();
      candidates = candidates.filter((r) => r.labels.some((entry: any) => entry.name.toLowerCase() === labelLower));
    }

    switch (sort) {
      case 'updated':
        candidates.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
        break;
      case 'created':
        candidates.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        break;
      case 'number':
        candidates.sort((a, b) => b.number - a.number);
        break;
      case 'comments':
        candidates.sort((a, b) => b.humanComments - a.humanComments);
        break;
      case 'score':
        candidates.sort((a, b) => b.compositeScore - a.compositeScore);
        break;
      case 'clips':
      default:
        candidates.sort((a, b) => (b.totalClips - a.totalClips) || (b.voterCount - a.voterCount) || (b.compositeScore - a.compositeScore));
        break;
    }

    if (limitStr) candidates = candidates.slice(0, parseInt(limitStr, 10));
    return c.json(candidates);
  });

  api.get('/prs/:number', async (c) => {
    const prNumber = parseInt(c.req.param('number'), 10);
    if (Number.isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);
    const db = await getDb();
    await settleResolvedLots(db);
    const viewer = await loadViewer(db, c.req.header('cookie'));
    const row = await db.get(`${PR_SELECT} WHERE pr.number = ?`, [prNumber]);
    if (!row) return c.json({ error: 'PR not found' }, 404);

    const viewerAllocation = viewer ? await getViewerAllocation(db, viewer.id, prNumber) : 0;
    const candidate = buildCandidate(row, viewerAllocation);
    const breakdown = scoreBreakdown(candidate.greptileScore, candidate.ciStatus, candidate.hasConflicts, candidate.humanComments, candidate.additions, candidate.deletions);

    const scores = await db.all('SELECT * FROM greptile_scores WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);
    const checks = await db.all('SELECT * FROM check_runs WHERE pr_number = ?', [prNumber]);
    const rawReviews = await db.all('SELECT * FROM llm_reviews WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);
    const reviews = rawReviews.map((entry: any) => ({
      ...entry,
      review: JSON.parse(entry.review_json),
    }));
    const voters = await db.all<any>(`
      SELECT
        u.handle,
        u.display_name,
        u.avatar_url,
        u.verified_type,
        SUM(lot.clips_remaining) as clips,
        MIN(lot.position_start) as first_position,
        AVG(lot.bonus_rate) as avg_bonus_rate
      FROM clip_allocation_lots lot
      JOIN users u ON u.id = lot.user_id
      WHERE lot.pr_number = ? AND lot.status = 'open'
      GROUP BY u.id
      ORDER BY clips DESC, first_position ASC
      LIMIT 60
    `, [prNumber]);

    return c.json({
      ...candidate,
      body: row.body ?? null,
      headSha: row.head_sha ?? null,
      scoreBreakdown: breakdown,
      greptileScores: scores,
      checks,
      reviews,
      voters: voters.map((entry: any) => ({
        handle: entry.handle,
        displayName: entry.display_name,
        avatarUrl: entry.avatar_url,
        verifiedType: entry.verified_type,
        clips: Number(entry.clips ?? 0),
        firstPosition: Number(entry.first_position ?? 0),
        avgBonusPct: formatPercent(Number(entry.avg_bonus_rate ?? 0)),
        profileUrl: `#/profile/${entry.handle}`,
        xUrl: `https://x.com/${entry.handle}`,
      })),
    });
  });

  api.post('/prs/:number/allocation', async (c) => {
    const prNumber = parseInt(c.req.param('number'), 10);
    if (Number.isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);
    const db = await getDb();
    await settleResolvedLots(db);
    const viewer = await loadViewer(db, c.req.header('cookie'));
    if (!viewer) return c.json({ error: 'Sign in first' }, 401);
    if (!isEligibleVerifiedType(viewer.verified_type)) {
      return c.json({ error: 'Your X account is not on an eligible paid tier right now' }, 403);
    }
    const body = await c.req.json().catch(() => ({} as any));
    const clips = Number(body.clips);
    if (!Number.isFinite(clips) || clips < 0) {
      return c.json({ error: 'clips must be a non-negative number' }, 400);
    }
    try {
      await setAbsoluteAllocation(db, {
        userId: viewer.id,
        prNumber,
        clips,
        discoveryCap: DEFAULT_DISCOVERY_CAP,
        consensusCap: DEFAULT_CONSENSUS_CAP,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
    const updatedViewer = await getSessionUser(db, parseCookie(c.req.header('cookie'), SESSION_COOKIE));
    return c.json({
      ok: true,
      session: await buildSessionPayload(db, updatedViewer),
      viewerAllocation: updatedViewer ? await getViewerAllocation(db, updatedViewer.id, prNumber) : 0,
    });
  });

  api.get('/me/allocations', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const viewer = await loadViewer(db, c.req.header('cookie'));
    if (!viewer) return c.json({ error: 'Sign in first' }, 401);

    const rows = await db.all<any>(`
      SELECT
        pr.number,
        pr.title,
        pr.state,
        pr.author,
        SUM(lot.clips_remaining) as clips,
        MIN(lot.position_start) as first_position,
        AVG(lot.bonus_rate) as avg_bonus_rate
      FROM clip_allocation_lots lot
      JOIN pull_requests pr ON pr.number = lot.pr_number
      WHERE lot.user_id = ? AND lot.status = 'open'
      GROUP BY pr.number
      ORDER BY clips DESC, first_position ASC
    `, [viewer.id]);
    return c.json(rows.map((row) => ({
      prNumber: row.number,
      title: row.title,
      state: row.state,
      author: row.author,
      clips: Number(row.clips ?? 0),
      firstPosition: Number(row.first_position ?? 0),
      avgBonusPct: formatPercent(Number(row.avg_bonus_rate ?? 0)),
    })));
  });

  api.get('/me/ledger', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const viewer = await loadViewer(db, c.req.header('cookie'));
    if (!viewer) return c.json({ error: 'Sign in first' }, 401);
    const rows = await db.all<any>(`
      SELECT ledger.*, pr.title
      FROM clip_ledger ledger
      LEFT JOIN pull_requests pr ON pr.number = ledger.pr_number
      WHERE ledger.user_id = ?
      ORDER BY ledger.created_at DESC
      LIMIT 250
    `, [viewer.id]);
    return c.json(rows.map((row) => ({
      id: row.id,
      prNumber: row.pr_number,
      prTitle: row.title,
      eventType: row.event_type,
      deltaClips: Number(row.delta_clips),
      note: row.note,
      createdAt: row.created_at,
    })));
  });

  api.get('/users/:handle', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const handle = String(c.req.param('handle') || '').toLowerCase();
    const user = await db.get<SessionUserRow>('SELECT * FROM users WHERE handle = ?', [handle]);
    if (!user) return c.json({ error: 'User not found' }, 404);

    const active = await db.all<any>(`
      SELECT
        pr.number,
        pr.title,
        pr.state,
        SUM(lot.clips_remaining) as clips,
        MIN(lot.position_start) as first_position,
        AVG(lot.bonus_rate) as avg_bonus_rate
      FROM clip_allocation_lots lot
      JOIN pull_requests pr ON pr.number = lot.pr_number
      WHERE lot.user_id = ? AND lot.status = 'open'
      GROUP BY pr.number
      ORDER BY clips DESC, first_position ASC
    `, [user.id]);

    const bestInvestments = await db.all<any>(`
      SELECT
        pr.number,
        pr.title,
        SUM(CASE WHEN ledger.event_type = 'merge_bonus' THEN ledger.delta_clips ELSE 0 END) as bonus_won,
        MIN(lot.position_start) as first_position
      FROM clip_ledger ledger
      JOIN pull_requests pr ON pr.number = ledger.pr_number
      LEFT JOIN clip_allocation_lots lot ON lot.id = ledger.lot_id
      WHERE ledger.user_id = ? AND ledger.pr_number IS NOT NULL
      GROUP BY pr.number
      HAVING bonus_won > 0
      ORDER BY bonus_won DESC, first_position ASC
      LIMIT 20
    `, [user.id]);

    const mergedRow = await db.get<{ count: number; avg_position: number | null }>(`
      SELECT COUNT(*) as count, AVG(position_start) as avg_position
      FROM clip_allocation_lots
      WHERE user_id = ? AND outcome = 'merged'
    `, [user.id]);

    const history = await db.all<any>(`
      SELECT
        ledger.id,
        ledger.pr_number,
        pr.title,
        ledger.event_type,
        ledger.delta_clips,
        ledger.note,
        ledger.created_at
      FROM clip_ledger ledger
      LEFT JOIN pull_requests pr ON pr.number = ledger.pr_number
      WHERE ledger.user_id = ?
      ORDER BY ledger.created_at DESC
      LIMIT 250
    `, [user.id]);

    return c.json({
      handle: user.handle,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      verifiedType: user.verified_type,
      subscriptionType: user.subscription_type,
      clipsBalance: user.clips_balance,
      totalClipsWon: user.total_clips_won,
      xUrl: `https://x.com/${user.handle}`,
      badges: deriveTasteBadges({
        mergedCount: Number(mergedRow?.count ?? 0),
        totalWon: user.total_clips_won,
        averageEntryPosition: mergedRow && mergedRow.avg_position !== null ? Number(mergedRow.avg_position) : null,
        activeAllocations: active.length,
      }),
      activeAllocations: active.map((row) => ({
        prNumber: row.number,
        title: row.title,
        clips: Number(row.clips ?? 0),
        firstPosition: Number(row.first_position ?? 0),
        avgBonusPct: formatPercent(Number(row.avg_bonus_rate ?? 0)),
      })),
      bestInvestments: bestInvestments.map((row) => ({
        prNumber: row.number,
        title: row.title,
        bonusWon: Number(row.bonus_won ?? 0),
        firstPosition: Number(row.first_position ?? 0),
      })),
      history: history.map((row) => ({
        id: row.id,
        prNumber: row.pr_number,
        prTitle: row.title,
        eventType: row.event_type,
        deltaClips: Number(row.delta_clips),
        note: row.note,
        createdAt: row.created_at,
      })),
    });
  });

  api.get('/search', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const q = (c.req.query('q') || '').trim();
    if (!q) return c.json({ error: 'Query parameter q is required' }, 400);
    const limit = parseInt(c.req.query('limit') || '20', 10);

    const prMatches = await safeSearch(
      () => db.all<any>(`
        SELECT number, title, body, bm25(pr_search_fts) as rank
        FROM pr_search_fts
        WHERE pr_search_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `, [q, limit]),
      () => db.all<any>(`
        SELECT number, title, body, 0 as rank
        FROM pull_requests
        WHERE title LIKE ? OR body LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `, [`%${q}%`, `%${q}%`, limit]),
    );

    const commentMatches = await safeSearch(
      () => db.all<any>(`
        SELECT c.comment_id, c.pr_number, c.author, c.body, c.created_at
        FROM pr_comments_fts fts
        JOIN pr_comments c ON c.comment_id = fts.rowid
        WHERE pr_comments_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `, [q, limit]),
      () => db.all<any>(`
        SELECT comment_id, pr_number, author, body, created_at
        FROM pr_comments
        WHERE body LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `, [`%${q}%`, limit]),
    );

    const prNumbers = [...new Set([
      ...prMatches.map((row: any) => Number(row.number)),
      ...commentMatches.map((row: any) => Number(row.pr_number)),
    ])];

    const grouped = new Map<number, any>();
    for (const prNumber of prNumbers) {
      const row = await db.get(`${PR_SELECT} WHERE pr.number = ?`, [prNumber]);
      if (!row) continue;
      grouped.set(prNumber, {
        ...buildCandidate(row),
        textMatches: [],
        commentMatches: [],
      });
    }

    for (const row of prMatches) {
      grouped.get(Number(row.number))?.textMatches.push({
        title: row.title,
        excerpt: excerpt(row.body, 220),
      });
    }
    for (const row of commentMatches) {
      grouped.get(Number(row.pr_number))?.commentMatches.push({
        author: row.author,
        excerpt: excerpt(row.body, 220),
        createdAt: row.created_at,
      });
    }

    return c.json({
      query: q,
      totalMatches: prMatches.length + commentMatches.length,
      prs: [...grouped.values()],
    });
  });

  api.get('/prs/:number/comments', async (c) => {
    const prNumber = parseInt(c.req.param('number'), 10);
    if (Number.isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);
    const db = await getDb();
    const comments = await db.all('SELECT * FROM pr_comments WHERE pr_number = ? ORDER BY created_at ASC', [prNumber]);
    return c.json(comments);
  });

  api.get('/labels', async (c) => {
    const db = await getDb();
    const rows = await db.all<{ labels_json: string }>(
      'SELECT labels_json FROM pull_requests WHERE labels_json IS NOT NULL AND labels_json != \'[]\'',
    );
    const labelMap = new Map<string, { name: string; color: string | null; count: number }>();
    for (const row of rows) {
      for (const label of safeJson(row.labels_json)) {
        const key = String(label.name || '').toLowerCase();
        if (!key) continue;
        const existing = labelMap.get(key);
        if (existing) existing.count += 1;
        else labelMap.set(key, { name: label.name, color: label.color ?? null, count: 1 });
      }
    }
    return c.json([...labelMap.values()].sort((a, b) => b.count - a.count));
  });

  api.get('/authors', async (c) => {
    const db = await getDb();
    const rows = await db.all<{ author: string; cnt: number }>(
      'SELECT author, COUNT(*) as cnt FROM pull_requests GROUP BY author ORDER BY cnt DESC',
    );
    return c.json(rows);
  });

  api.get('/scoring', (_c) => {
    return _c.json({
      description: 'Composite score (0-115) computed from five signals',
      formula: {
        greptile: { weight: '0-40', calculation: 'greptileScore * 8', note: 'Greptile bot confidence score (1-5) from PR comments' },
        ci: { weight: '0-25', values: { passing: 25, pending: 12, unknown: 8, failing: 0 } },
        conflicts: { weight: '-15 to +15', values: { noConflicts: 15, hasConflicts: -15 } },
        humanComments: { weight: '0-20', values: { '0': 0, '1': 10, '2+': 20 }, note: 'Excludes bot comments (authors matching *[bot])' },
        loc: { weight: '0-15', calculation: 'max(0, round(15 - 3 * log10(totalLoc)))', note: 'Fewer lines changed = higher score' },
      },
      maxScore: 115,
      minScore: 0,
    });
  });

  api.get('/stats', async (c) => {
    const db = await getDb();
    await settleResolvedLots(db);
    const total = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pull_requests WHERE state = \'open\'');
    const mergedCount = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'merged_count'");
    const closedCount = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'closed_count'");
    const withScores = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT pr_number) as cnt FROM greptile_scores');
    const reviewed = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT pr_number) as cnt FROM llm_reviews');
    const comments = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pr_comments');
    const lastSync = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'last_sync_at'");
    const activeVoters = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT user_id) as cnt FROM clip_allocation_lots WHERE status = \'open\'');
    const totalClips = await db.get<{ total: number }>('SELECT COALESCE(SUM(clips_remaining), 0) as total FROM clip_allocation_lots WHERE status = \'open\'');
    const users = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM users');

    return c.json({
      totalPRs: total?.cnt ?? 0,
      openPRs: total?.cnt ?? 0,
      mergedPRs: mergedCount ? parseInt(mergedCount.value, 10) : 0,
      closedPRs: closedCount ? parseInt(closedCount.value, 10) : 0,
      withGreptileScores: withScores?.cnt ?? 0,
      llmReviewed: reviewed?.cnt ?? 0,
      totalComments: comments?.cnt ?? 0,
      lastSyncAt: lastSync?.value ?? null,
      activeVoters: activeVoters?.cnt ?? 0,
      activeClips: Number(totalClips?.total ?? 0),
      signedInUsers: users?.cnt ?? 0,
      discoveryCap: DEFAULT_DISCOVERY_CAP,
      consensusCap: DEFAULT_CONSENSUS_CAP,
      generatedAt: nowIso(),
    });
  });

  return api;
}
