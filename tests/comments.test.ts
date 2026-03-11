import { describe, it, expect } from 'vitest';
import { parseGreptileScores } from '../src/github/comments';

describe('parseGreptileScores', () => {
  it('parses valid greptile bot comment', () => {
    const comments = [{
      id: 100,
      user: { login: 'greptile-apps[bot]' },
      body: 'Some review text\n### Confidence Score: 4/5\nMore details',
      created_at: '2024-01-01T00:00:00Z',
    }];
    const scores = parseGreptileScores(comments);
    expect(scores).toHaveLength(1);
    expect(scores[0].confidenceScore).toBe(4);
    expect(scores[0].commentId).toBe(100);
  });

  it('ignores non-bot comments with score pattern', () => {
    const comments = [{
      id: 200,
      user: { login: 'malicious-user' },
      body: '### Confidence Score: 5/5\nFake high score',
      created_at: '2024-01-01T00:00:00Z',
    }];
    const scores = parseGreptileScores(comments);
    expect(scores).toHaveLength(0);
  });

  it('ignores bot comments without score', () => {
    const comments = [{
      id: 300,
      user: { login: 'greptile-apps[bot]' },
      body: 'General review without a confidence score',
      created_at: '2024-01-01T00:00:00Z',
    }];
    const scores = parseGreptileScores(comments);
    expect(scores).toHaveLength(0);
  });

  it('handles null user', () => {
    const comments = [{
      id: 400,
      user: null as any,
      body: '### Confidence Score: 3/5',
      created_at: '2024-01-01T00:00:00Z',
    }];
    const scores = parseGreptileScores(comments);
    expect(scores).toHaveLength(0);
  });

  it('rejects scores outside 1-5 range', () => {
    const comments = [{
      id: 500,
      user: { login: 'greptile-apps[bot]' },
      body: '### Confidence Score: 0/5',
      created_at: '2024-01-01T00:00:00Z',
    }, {
      id: 501,
      user: { login: 'greptile-apps[bot]' },
      body: '### Confidence Score: 9/5',
      created_at: '2024-01-01T00:00:00Z',
    }];
    const scores = parseGreptileScores(comments);
    expect(scores).toHaveLength(0);
  });

  it('handles multiple bot comments on same PR', () => {
    const comments = [{
      id: 600,
      user: { login: 'greptile-apps[bot]' },
      body: '### Confidence Score: 3/5',
      created_at: '2024-01-01T00:00:00Z',
    }, {
      id: 601,
      user: { login: 'greptile-apps[bot]' },
      body: '### Confidence Score: 4/5',
      created_at: '2024-01-02T00:00:00Z',
    }];
    const scores = parseGreptileScores(comments);
    expect(scores).toHaveLength(2);
    expect(scores[0].confidenceScore).toBe(3);
    expect(scores[1].confidenceScore).toBe(4);
  });

  it('rejects fake scores in PR titles embedded as comments', () => {
    // Attacker puts a score pattern in a regular user comment
    const comments = [{
      id: 700,
      user: { login: 'attacker' },
      body: 'I think this deserves ### Confidence Score: 5/5 for sure',
      created_at: '2024-01-01T00:00:00Z',
    }];
    const scores = parseGreptileScores(comments);
    expect(scores).toHaveLength(0);
  });

  it('handles empty body', () => {
    const comments = [{
      id: 800,
      user: { login: 'greptile-apps[bot]' },
      body: undefined as any,
      created_at: '2024-01-01T00:00:00Z',
    }];
    const scores = parseGreptileScores(comments);
    expect(scores).toHaveLength(0);
  });
});
