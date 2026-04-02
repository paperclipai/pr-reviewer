export const DEFAULT_DISCOVERY_CAP = 50;
export const DEFAULT_CONSENSUS_CAP = 500;
export const STARTING_CLIPS = 10;

const ELIGIBLE_VERIFIED_TYPES = new Set([
  'blue',
  'gold',
  'gray',
  'business',
  'government',
]);

export function normalizeVerifiedType(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'gold') return 'business';
  if (normalized === 'gray') return 'government';
  return normalized;
}

export function isEligibleVerifiedType(value: string | null | undefined): boolean {
  const normalized = normalizeVerifiedType(value);
  return normalized !== null && ELIGIBLE_VERIFIED_TYPES.has(normalized);
}

export function bonusRateForPosition(
  position: number,
  discoveryCap: number = DEFAULT_DISCOVERY_CAP,
  consensusCap: number = DEFAULT_CONSENSUS_CAP,
): number {
  if (position <= 0) return 0;
  if (position <= discoveryCap) return 1;
  if (position >= consensusCap) return 0;
  const span = consensusCap - discoveryCap;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (consensusCap - position) / span));
}

export function averageBonusRateForRange(
  startPosition: number,
  endPosition: number,
  discoveryCap: number = DEFAULT_DISCOVERY_CAP,
  consensusCap: number = DEFAULT_CONSENSUS_CAP,
): number {
  if (endPosition < startPosition) return 0;
  let total = 0;
  let count = 0;
  for (let position = startPosition; position <= endPosition; position += 1) {
    total += bonusRateForPosition(position, discoveryCap, consensusCap);
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

export function clipsPhase(
  totalClips: number,
  discoveryCap: number = DEFAULT_DISCOVERY_CAP,
  consensusCap: number = DEFAULT_CONSENSUS_CAP,
): 'discovery' | 'momentum' | 'consensus' {
  if (totalClips < discoveryCap) return 'discovery';
  if (totalClips < consensusCap) return 'momentum';
  return 'consensus';
}

export function consensusProgress(
  totalClips: number,
  consensusCap: number = DEFAULT_CONSENSUS_CAP,
): number {
  if (consensusCap <= 0) return 0;
  return Math.max(0, Math.min(1, totalClips / consensusCap));
}

export function formatPercent(value: number): number {
  return Math.round(value * 100);
}

export interface TasteBadge {
  id: string;
  label: string;
  description: string;
}

export function deriveTasteBadges(input: {
  mergedCount: number;
  totalWon: number;
  averageEntryPosition: number | null;
  activeAllocations: number;
}): TasteBadge[] {
  const badges: TasteBadge[] = [];
  if (input.averageEntryPosition !== null && input.averageEntryPosition <= DEFAULT_DISCOVERY_CAP) {
    badges.push({
      id: 'early-scout',
      label: 'Early Scout',
      description: 'Usually arrives before the crowd does.',
    });
  }
  if (input.mergedCount >= 3) {
    badges.push({
      id: 'ship-whisperer',
      label: 'Ship Whisperer',
      description: 'Backed multiple pull requests that actually merged.',
    });
  }
  if (input.totalWon >= STARTING_CLIPS) {
    badges.push({
      id: 'taste-maker',
      label: 'Taste Maker',
      description: 'Turned good instincts into extra clips.',
    });
  }
  if (input.activeAllocations >= 5) {
    badges.push({
      id: 'portfolio-brain',
      label: 'Portfolio Brain',
      description: 'Spreads conviction across several live bets.',
    });
  }
  return badges;
}
