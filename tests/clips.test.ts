import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSENSUS_CAP,
  DEFAULT_DISCOVERY_CAP,
  averageBonusRateForRange,
  bonusRateForPosition,
  clipsPhase,
  isEligibleVerifiedType,
} from '../src/clips';

describe('clip reward curve', () => {
  it('uses the requested 50 / 500 defaults', () => {
    expect(DEFAULT_DISCOVERY_CAP).toBe(50);
    expect(DEFAULT_CONSENSUS_CAP).toBe(500);
  });

  it('gives full bonus inside discovery', () => {
    expect(bonusRateForPosition(1)).toBe(1);
    expect(bonusRateForPosition(50)).toBe(1);
  });

  it('decays after discovery and hits zero at consensus', () => {
    expect(bonusRateForPosition(51)).toBeLessThan(1);
    expect(bonusRateForPosition(250)).toBeGreaterThan(0);
    expect(bonusRateForPosition(500)).toBe(0);
    expect(bonusRateForPosition(900)).toBe(0);
  });

  it('averages multi-clip lots across the occupied range', () => {
    const earlyLot = averageBonusRateForRange(1, 5);
    const lateLot = averageBonusRateForRange(451, 455);
    expect(earlyLot).toBe(1);
    expect(lateLot).toBeLessThan(0.12);
  });

  it('derives phase names from total clips on a PR', () => {
    expect(clipsPhase(0)).toBe('discovery');
    expect(clipsPhase(100)).toBe('momentum');
    expect(clipsPhase(500)).toBe('consensus');
  });
});

describe('eligibility', () => {
  it('treats all requested paid tiers as eligible', () => {
    expect(isEligibleVerifiedType('blue')).toBe(true);
    expect(isEligibleVerifiedType('gold')).toBe(true);
    expect(isEligibleVerifiedType('gray')).toBe(true);
    expect(isEligibleVerifiedType('business')).toBe(true);
    expect(isEligibleVerifiedType('government')).toBe(true);
  });

  it('rejects missing or unknown tiers', () => {
    expect(isEligibleVerifiedType('')).toBe(false);
    expect(isEligibleVerifiedType(null)).toBe(false);
    expect(isEligibleVerifiedType('legacy')).toBe(false);
  });
});
