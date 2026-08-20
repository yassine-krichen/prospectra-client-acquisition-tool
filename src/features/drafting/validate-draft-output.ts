import { BANNED_PHRASES, MAX_WORDS, MIN_WORDS } from '@/features/drafting/prompt-templates';
import type { ParsedDraftOutput } from '@/features/drafting/parse-draft-output';

// Post-generation safety net for the hard constraints prompt-templates.ts
// only asks the model for as instructions. Models don't always comply, so
// this re-checks the model's actual output rather than trusting the prompt
// alone - see drafting.service.ts for how a failure here is handled.

export type DraftConstraintViolation = 'word_count' | 'banned_phrase';

export interface DraftValidationSuccess {
  valid: true;
}

export interface DraftValidationFailure {
  valid: false;
  violations: DraftConstraintViolation[];
  /** Human-readable detail per violated constraint, for logging/flagging. */
  reasons: string[];
}

export type DraftValidationResult = DraftValidationSuccess | DraftValidationFailure;

function countWords(body: string): number {
  return body.trim().length === 0 ? 0 : body.trim().split(/\s+/).length;
}

function findBannedPhrases(body: string): string[] {
  const lowerBody = body.toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lowerBody.includes(phrase.toLowerCase()));
}

/**
 * Validates a parsed `{subject, body}` draft against the hard constraints
 * from prompt-templates.ts: `body`'s word count must fall within
 * `[MIN_WORDS, MAX_WORDS]` inclusive, and `body` must not contain a
 * case-insensitive substring match of any `BANNED_PHRASES` entry. Returns
 * every violated constraint rather than stopping at the first, so a caller
 * flagging the draft for human review can report the full picture.
 */
export function validateDraftOutput(draft: ParsedDraftOutput): DraftValidationResult {
  const violations: DraftConstraintViolation[] = [];
  const reasons: string[] = [];

  const wordCount = countWords(draft.body);
  if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
    violations.push('word_count');
    reasons.push(`body has ${wordCount} words, outside the required ${MIN_WORDS}-${MAX_WORDS} range`);
  }

  const bannedMatches = findBannedPhrases(draft.body);
  if (bannedMatches.length > 0) {
    violations.push('banned_phrase');
    reasons.push(`body contains banned phrase(s): ${bannedMatches.join(', ')}`);
  }

  if (violations.length > 0) {
    return { valid: false, violations, reasons };
  }

  return { valid: true };
}
