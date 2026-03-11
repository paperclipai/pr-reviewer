export type CIStatus = 'passing' | 'failing' | 'pending' | 'unknown';

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  updatedAt: string;
}

export function aggregateCheckStatus(checks: CheckRun[]): CIStatus {
  if (checks.length === 0) return 'unknown';

  const hasFailure = checks.some(
    c => c.status === 'completed' && c.conclusion !== 'success' && c.conclusion !== 'skipped' && c.conclusion !== 'neutral'
  );
  if (hasFailure) return 'failing';

  const hasPending = checks.some(c => c.status !== 'completed');
  if (hasPending) return 'pending';

  return 'passing';
}
