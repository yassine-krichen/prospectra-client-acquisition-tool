import { describe, expect, it } from 'vitest';

import { MAX_WORDS, MIN_WORDS } from './prompt-templates';
import { validateDraftOutput } from './validate-draft-output';

function words(count: number): string {
  return Array(count).fill('word').join(' ');
}

describe('validateDraftOutput', () => {
  it('passes a clean draft whose body is within the word-count range and has no banned phrases', () => {
    const result = validateDraftOutput({ subject: 'Subject line', body: words(MIN_WORDS) });

    expect(result).toEqual({ valid: true });
  });

  it('passes a body with exactly MIN_WORDS words (the lower boundary is inclusive)', () => {
    const result = validateDraftOutput({ subject: 'Subject', body: words(MIN_WORDS) });

    expect(result.valid).toBe(true);
  });

  it('passes a body with exactly MAX_WORDS words (the upper boundary is inclusive)', () => {
    const result = validateDraftOutput({ subject: 'Subject', body: words(MAX_WORDS) });

    expect(result.valid).toBe(true);
  });

  it('fails a body with one word fewer than MIN_WORDS', () => {
    const result = validateDraftOutput({ subject: 'Subject', body: words(MIN_WORDS - 1) });

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected an invalid result');
    expect(result.violations).toContain('word_count');
  });

  it('fails a body with one word more than MAX_WORDS', () => {
    const result = validateDraftOutput({ subject: 'Subject', body: words(MAX_WORDS + 1) });

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected an invalid result');
    expect(result.violations).toContain('word_count');
  });

  it('fails a body containing a banned phrase, matched case-insensitively', () => {
    const body = `${words(MIN_WORDS)} I Hope This Finds You Well and thanks for your time.`;

    const result = validateDraftOutput({ subject: 'Subject', body });

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected an invalid result');
    expect(result.violations).toContain('banned_phrase');
    expect(result.reasons.join(' ')).toContain('hope this finds you well');
  });

  it('reports both violations at once when a body is both out of range and contains a banned phrase', () => {
    const result = validateDraftOutput({ subject: 'Subject', body: 'circle back soon' });

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected an invalid result');
    expect(result.violations).toEqual(expect.arrayContaining(['word_count', 'banned_phrase']));
  });
});
