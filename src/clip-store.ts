import type { DbClient, BatchStatement } from './db/types';
import {
  averageBonusRateForRange,
  DEFAULT_CONSENSUS_CAP,
  DEFAULT_DISCOVERY_CAP,
  STARTING_CLIPS,
  isEligibleVerifiedType,
  normalizeVerifiedType,
} from './clips';

export interface SessionUserRow {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  verified_type: string | null;
  subscription_type: string | null;
  clips_balance: number;
  total_clips_won: number;
}

interface AllocationLotRow {
  id: string;
  user_id: string;
  pr_number: number;
  clips_locked: number;
  clips_remaining: number;
  bonus_rate: number;
  bonus_rate_bps: number;
  position_start: number;
  position_end: number;
  status: string;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

export async function getSessionUser(db: DbClient, token: string | null | undefined): Promise<SessionUserRow | null> {
  if (!token) return null;
  const now = nowIso();
  return await db.get<SessionUserRow>(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `, [token, now]);
}

export async function createDemoSession(
  db: DbClient,
  input: { handle: string; displayName?: string | null; verifiedType?: string | null; subscriptionType?: string | null; avatarUrl?: string | null },
): Promise<{ token: string; user: SessionUserRow }> {
  const handle = normalizeHandle(input.handle);
  if (!handle) {
    throw new Error('A valid handle is required');
  }

  const verifiedType = normalizeVerifiedType(input.verifiedType);
  const subscriptionType = input.subscriptionType?.trim() || null;
  const avatarUrl = input.avatarUrl?.trim() || `https://unavatar.io/x/${handle}`;
  const displayName = input.displayName?.trim() || `@${handle}`;
  const now = nowIso();

  let user = await db.get<SessionUserRow>('SELECT * FROM users WHERE handle = ?', [handle]);
  const batch: BatchStatement[] = [];

  if (!user) {
    user = {
      id: makeId(),
      handle,
      display_name: displayName,
      avatar_url: avatarUrl,
      verified_type: verifiedType,
      subscription_type: subscriptionType,
      clips_balance: 0,
      total_clips_won: 0,
    };
    batch.push({
      sql: `
        INSERT INTO users (id, handle, display_name, avatar_url, verified_type, subscription_type, clips_balance, total_clips_won, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      `,
      params: [user.id, handle, displayName, avatarUrl, verifiedType, subscriptionType, now, now],
    });
  } else {
    batch.push({
      sql: `
        UPDATE users
        SET display_name = ?, avatar_url = ?, verified_type = ?, subscription_type = ?, updated_at = ?
        WHERE id = ?
      `,
      params: [displayName, avatarUrl, verifiedType, subscriptionType, now, user.id],
    });
  }

  const grantExists = await db.get<{ found: number }>(
    `SELECT 1 as found FROM clip_ledger WHERE user_id = ? AND event_type = 'signup_grant' LIMIT 1`,
    [user.id],
  );

  if (isEligibleVerifiedType(verifiedType) && !grantExists) {
    batch.push({
      sql: `UPDATE users SET clips_balance = clips_balance + ?, updated_at = ? WHERE id = ?`,
      params: [STARTING_CLIPS, now, user.id],
    });
    batch.push({
      sql: `INSERT INTO clip_ledger (id, user_id, pr_number, lot_id, event_type, delta_clips, note, created_at)
            VALUES (?, ?, NULL, NULL, 'signup_grant', ?, ?, ?)`,
      params: [makeId(), user.id, STARTING_CLIPS, 'First verified login grant', now],
    });
  }

  const token = `${makeId()}-${Math.random().toString(36).slice(2)}`;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  batch.push({
    sql: `INSERT INTO sessions (id, user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    params: [makeId(), user.id, token, expiresAt, now],
  });
  batch.push({
    sql: `DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?`,
    params: [user.id, now],
  });

  await db.runBatch(batch);
  const freshUser = await db.get<SessionUserRow>('SELECT * FROM users WHERE id = ?', [user.id]);
  if (!freshUser) {
    throw new Error('Unable to load session user');
  }
  return { token, user: freshUser };
}

export async function destroySession(db: DbClient, token: string | null | undefined): Promise<void> {
  if (!token) return;
  await db.run(`DELETE FROM sessions WHERE token = ?`, [token]);
}

export async function settleResolvedLots(db: DbClient): Promise<void> {
  const openLots = await db.all<(AllocationLotRow & { pr_state: string })>(`
    SELECT lot.*, pr.state as pr_state
    FROM clip_allocation_lots lot
    JOIN pull_requests pr ON pr.number = lot.pr_number
    WHERE lot.status = 'open' AND pr.state != 'open'
    ORDER BY lot.created_at ASC
  `);

  if (openLots.length === 0) return;

  const now = nowIso();
  const batch: BatchStatement[] = [];

  for (const lot of openLots) {
    if (lot.clips_remaining <= 0) {
      batch.push({
        sql: `UPDATE clip_allocation_lots SET status = 'resolved', updated_at = ?, resolved_at = ? WHERE id = ?`,
        params: [now, now, lot.id],
      });
      continue;
    }

    let refund = lot.clips_remaining;
    let bonus = 0;
    let note = 'Closed without merge; principal returned';
    let outcome = 'closed';

    if (lot.pr_state === 'merged') {
      bonus = Math.round(lot.clips_remaining * lot.bonus_rate);
      note = `Merged with ${(lot.bonus_rate * 100).toFixed(0)}% early-signal bonus`;
      outcome = 'merged';
    }

    batch.push({
      sql: `UPDATE users SET clips_balance = clips_balance + ?, total_clips_won = total_clips_won + ?, updated_at = ? WHERE id = ?`,
      params: [refund + bonus, bonus, now, lot.user_id],
    });
    batch.push({
      sql: `INSERT INTO clip_ledger (id, user_id, pr_number, lot_id, event_type, delta_clips, note, created_at)
            VALUES (?, ?, ?, ?, 'principal_return', ?, ?, ?)`,
      params: [makeId(), lot.user_id, lot.pr_number, lot.id, refund, note, now],
    });
    if (bonus > 0) {
      batch.push({
        sql: `INSERT INTO clip_ledger (id, user_id, pr_number, lot_id, event_type, delta_clips, note, created_at)
              VALUES (?, ?, ?, ?, 'merge_bonus', ?, ?, ?)`,
        params: [makeId(), lot.user_id, lot.pr_number, lot.id, bonus, 'Early-signal bonus payout', now],
      });
    }
    batch.push({
      sql: `UPDATE clip_allocation_lots
            SET status = 'resolved', outcome = ?, clips_remaining = 0, updated_at = ?, resolved_at = ?
            WHERE id = ?`,
      params: [outcome, now, now, lot.id],
    });
  }

  await db.runBatch(batch);
}

export async function setAbsoluteAllocation(
  db: DbClient,
  input: { userId: string; prNumber: number; clips: number; discoveryCap?: number; consensusCap?: number },
): Promise<void> {
  const target = Math.max(0, Math.floor(input.clips));
  const discoveryCap = input.discoveryCap ?? DEFAULT_DISCOVERY_CAP;
  const consensusCap = input.consensusCap ?? DEFAULT_CONSENSUS_CAP;
  const now = nowIso();

  const pr = await db.get<{ number: number; state: string }>('SELECT number, state FROM pull_requests WHERE number = ?', [input.prNumber]);
  if (!pr) throw new Error('PR not found');
  if (pr.state !== 'open') throw new Error('You can only allocate clips to open PRs');

  const user = await db.get<SessionUserRow>('SELECT * FROM users WHERE id = ?', [input.userId]);
  if (!user) throw new Error('User not found');

  const lots = await db.all<AllocationLotRow>(`
    SELECT *
    FROM clip_allocation_lots
    WHERE user_id = ? AND pr_number = ? AND status = 'open'
    ORDER BY created_at DESC, id DESC
  `, [input.userId, input.prNumber]);

  const current = lots.reduce((sum, lot) => sum + lot.clips_remaining, 0);
  if (target === current) return;

  const batch: BatchStatement[] = [];

  if (target > current) {
    const delta = target - current;
    if (user.clips_balance < delta) {
      throw new Error(`Not enough clips. You have ${user.clips_balance} available.`);
    }
    const clipTotal = await db.get<{ total: number }>(
      `SELECT COALESCE(SUM(clips_remaining), 0) as total FROM clip_allocation_lots WHERE pr_number = ? AND status = 'open'`,
      [input.prNumber],
    );
    const positionStart = (clipTotal?.total ?? 0) + 1;
    const positionEnd = positionStart + delta - 1;
    const bonusRate = averageBonusRateForRange(positionStart, positionEnd, discoveryCap, consensusCap);
    const lotId = makeId();

    batch.push({
      sql: `
        INSERT INTO clip_allocation_lots (
          id, user_id, pr_number, clips_locked, clips_remaining, bonus_rate, bonus_rate_bps,
          position_start, position_end, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      `,
      params: [
        lotId,
        input.userId,
        input.prNumber,
        delta,
        delta,
        bonusRate,
        Math.round(bonusRate * 10000),
        positionStart,
        positionEnd,
        now,
        now,
      ],
    });
    batch.push({
      sql: `UPDATE users SET clips_balance = clips_balance - ?, updated_at = ? WHERE id = ?`,
      params: [delta, now, input.userId],
    });
    batch.push({
      sql: `INSERT INTO clip_ledger (id, user_id, pr_number, lot_id, event_type, delta_clips, note, created_at)
            VALUES (?, ?, ?, ?, 'allocation_lock', ?, ?, ?)`,
      params: [makeId(), input.userId, input.prNumber, lotId, -delta, `Locked at positions ${positionStart}-${positionEnd}`, now],
    });
  } else {
    let remainingToUnlock = current - target;
    for (const lot of lots) {
      if (remainingToUnlock <= 0) break;
      const consume = Math.min(lot.clips_remaining, remainingToUnlock);
      const nextRemaining = lot.clips_remaining - consume;
      if (nextRemaining === 0) {
        batch.push({
          sql: `UPDATE clip_allocation_lots
                SET clips_remaining = 0, status = 'withdrawn', outcome = 'withdrawn', updated_at = ?, resolved_at = ?
                WHERE id = ?`,
          params: [now, now, lot.id],
        });
      } else {
        batch.push({
          sql: `UPDATE clip_allocation_lots SET clips_remaining = ?, updated_at = ? WHERE id = ?`,
          params: [nextRemaining, now, lot.id],
        });
      }
      batch.push({
        sql: `UPDATE users SET clips_balance = clips_balance + ?, updated_at = ? WHERE id = ?`,
        params: [consume, now, input.userId],
      });
      batch.push({
        sql: `INSERT INTO clip_ledger (id, user_id, pr_number, lot_id, event_type, delta_clips, note, created_at)
              VALUES (?, ?, ?, ?, 'allocation_unlock', ?, ?, ?)`,
        params: [makeId(), input.userId, input.prNumber, lot.id, consume, 'Unlocked from active position', now],
      });
      remainingToUnlock -= consume;
    }
  }

  await db.runBatch(batch);
}
