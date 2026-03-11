import crypto from 'crypto';

function generateBoundary(): string {
  return `===UNTRUSTED_DATA_${crypto.randomBytes(16).toString('hex')}===`;
}

/** Strip control characters except newlines and tabs */
export function stripControlChars(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export interface SanitizedContent {
  wrapped: string;
  boundary: string;
}

/** Wrap untrusted content in random boundary delimiters */
export function wrapUntrusted(label: string, content: string): SanitizedContent {
  const boundary = generateBoundary();
  const cleaned = stripControlChars(content);
  const wrapped = `${boundary}\n[BEGIN ${label}]\n${cleaned}\n[END ${label}]\n${boundary}`;
  return { wrapped, boundary };
}

/** Sanitize all untrusted PR fields, returning wrapped content and all boundaries used */
export function sanitizePRContent(pr: {
  title: string;
  body: string | null;
  comments?: string[];
}): { sections: string; boundaries: string[] } {
  const boundaries: string[] = [];
  const parts: string[] = [];

  const titleResult = wrapUntrusted('PR_TITLE', pr.title);
  boundaries.push(titleResult.boundary);
  parts.push(titleResult.wrapped);

  if (pr.body) {
    const bodyResult = wrapUntrusted('PR_BODY', pr.body);
    boundaries.push(bodyResult.boundary);
    parts.push(bodyResult.wrapped);
  }

  if (pr.comments) {
    for (let i = 0; i < pr.comments.length; i++) {
      const commentResult = wrapUntrusted(`COMMENT_${i}`, pr.comments[i]);
      boundaries.push(commentResult.boundary);
      parts.push(commentResult.wrapped);
    }
  }

  return { sections: parts.join('\n\n'), boundaries };
}

const HIJACKING_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?prior/i,
  /you\s+are\s+now\s+/i,
  /new\s+system\s+prompt/i,
  /override\s+.*instructions/i,
  /act\s+as\s+(a\s+)?different/i,
  /forget\s+(all\s+)?previous/i,
];

/** Check LLM output for signs of prompt injection hijacking */
export function validateOutput(output: string): { valid: boolean; flags: string[] } {
  const flags: string[] = [];

  for (const pattern of HIJACKING_PATTERNS) {
    if (pattern.test(output)) {
      flags.push(`Suspicious pattern: ${pattern.source}`);
    }
  }

  return { valid: flags.length === 0, flags };
}
