import { describe, it, expect } from 'vitest';
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
  // Mirror the scoring formula from src/scoring/filter.ts and src/web/routes.ts
  function computeCompositeScore(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean, humanComments: number): number {
    let score = 0;
    // Greptile: 0-40
    if (greptileScore !== null) score += greptileScore * 8;
    // CI: 0-25
    switch (ciStatus) {
      case 'passing': score += 25; break;
      case 'pending': score += 12; break;
      case 'unknown': score += 8; break;
      case 'failing': score += 0; break;
    }
    // Conflicts: +/-15
    score += hasConflicts ? -15 : 15;
    // Human comments: 0-20
    if (humanComments >= 2) score += 20;
    else if (humanComments === 1) score += 10;
    return Math.max(0, Math.min(100, score));
  }

  it('max score: greptile 5 + passing CI + no conflicts + 2 comments = 100', () => {
    expect(computeCompositeScore(5, 'passing', false, 2)).toBe(100);
  });

  it('min score: no greptile + failing CI + conflicts + 0 comments = 0', () => {
    expect(computeCompositeScore(null, 'failing', true, 0)).toBe(0);
  });

  it('greptile 3 + passing CI + no conflicts + 0 comments = 64', () => {
    expect(computeCompositeScore(3, 'passing', false, 0)).toBe(64);
  });

  it('conflicts reduce score by 30 vs no conflicts', () => {
    const withConflicts = computeCompositeScore(3, 'passing', true, 0);
    const noConflicts = computeCompositeScore(3, 'passing', false, 0);
    expect(noConflicts - withConflicts).toBe(30);
  });

  it('1 human comment adds 10 points', () => {
    const none = computeCompositeScore(3, 'passing', false, 0);
    const one = computeCompositeScore(3, 'passing', false, 1);
    expect(one - none).toBe(10);
  });

  it('2+ human comments add 20 points', () => {
    const none = computeCompositeScore(3, 'passing', false, 0);
    const two = computeCompositeScore(3, 'passing', false, 2);
    expect(two - none).toBe(20);
  });

  it('clamps to 0-100 range', () => {
    expect(computeCompositeScore(null, 'failing', true, 0)).toBe(0);
    expect(computeCompositeScore(5, 'passing', false, 5)).toBe(100);
  });
});
