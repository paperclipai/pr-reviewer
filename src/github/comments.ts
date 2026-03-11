const GREPTILE_BOT_LOGIN = 'greptile-apps[bot]';
const CONFIDENCE_REGEX = /###\s*Confidence\s+Score:\s*(\d)\s*\/\s*5/i;

export interface GreptileScore {
  commentId: number;
  confidenceScore: number;
  commentBody: string;
  createdAt: string;
}

export function parseGreptileScores(comments: Array<{
  id: number;
  user: { login: string } | null;
  body?: string;
  created_at: string;
}>): GreptileScore[] {
  const scores: GreptileScore[] = [];

  for (const comment of comments) {
    // Only trust comments from the greptile bot
    if (comment.user?.login !== GREPTILE_BOT_LOGIN) continue;
    if (!comment.body) continue;

    const match = comment.body.match(CONFIDENCE_REGEX);
    if (!match) continue;

    const score = parseInt(match[1], 10);
    if (score < 1 || score > 5) continue;

    scores.push({
      commentId: comment.id,
      confidenceScore: score,
      commentBody: comment.body,
      createdAt: comment.created_at,
    });
  }

  return scores;
}
