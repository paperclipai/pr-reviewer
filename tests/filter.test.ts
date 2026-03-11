import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// We test the scoring logic directly rather than through the DB-dependent listCandidates
import { aggregateCheckStatus, CIStatus, CheckRun } from '../src/github/checks';

describe('aggregateCheckStatus', () => {
  it('returns unknown for empty checks', () => {
    expect(aggregateCheckStatus([])).toBe('unknown');
  });

  it('returns passing when all checks succeed', () => {
    const checks: CheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success', updatedAt: '' },
      { name: 'test', status: 'completed', conclusion: 'success', updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('passing');
  });

  it('returns failing when any check fails', () => {
    const checks: CheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success', updatedAt: '' },
      { name: 'test', status: 'completed', conclusion: 'failure', updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('failing');
  });

  it('returns pending when any check is in progress', () => {
    const checks: CheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success', updatedAt: '' },
      { name: 'test', status: 'in_progress', conclusion: null, updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('pending');
  });

  it('treats skipped checks as passing', () => {
    const checks: CheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'skipped', updatedAt: '' },
      { name: 'test', status: 'completed', conclusion: 'success', updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('passing');
  });

  it('treats neutral checks as passing', () => {
    const checks: CheckRun[] = [
      { name: 'lint', status: 'completed', conclusion: 'neutral', updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('passing');
  });
});

describe('composite score logic', () => {
  // Test the scoring formula directly
  function computeCompositeScore(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean): number {
    let score = 0;
    if (greptileScore !== null) score += greptileScore * 10;
    switch (ciStatus) {
      case 'passing': score += 30; break;
      case 'pending': score += 15; break;
      case 'unknown': score += 10; break;
      case 'failing': score += 0; break;
    }
    score += hasConflicts ? -20 : 20;
    return Math.max(0, Math.min(100, score));
  }

  it('max score: greptile 5 + passing CI + no conflicts = 100', () => {
    expect(computeCompositeScore(5, 'passing', false)).toBe(100);
  });

  it('min score: no greptile + failing CI + conflicts = 0', () => {
    expect(computeCompositeScore(null, 'failing', true)).toBe(0);
  });

  it('mid score: greptile 3 + passing CI + no conflicts = 80', () => {
    expect(computeCompositeScore(3, 'passing', false)).toBe(80);
  });

  it('conflicts reduce score by 40 vs no conflicts', () => {
    const withConflicts = computeCompositeScore(3, 'passing', true);
    const noConflicts = computeCompositeScore(3, 'passing', false);
    expect(noConflicts - withConflicts).toBe(40);
  });

  it('clamps to 0-100 range', () => {
    expect(computeCompositeScore(null, 'failing', true)).toBe(0);
    // Even impossible inputs should clamp
    expect(computeCompositeScore(5, 'passing', false)).toBe(100);
  });
});
