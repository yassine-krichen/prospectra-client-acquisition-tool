import { describe, expect, it } from 'vitest';

import { generateEmailGuesses } from './pattern-guess';

describe('generateEmailGuesses', () => {
  it('generates the full first/last-name pattern set, most-likely first, ending in the generic role addresses', () => {
    const guesses = generateEmailGuesses('Jane Doe', 'acme.com');

    expect(guesses).toEqual([
      'jane@acme.com',
      'jane.doe@acme.com',
      'janedoe@acme.com',
      'jdoe@acme.com',
      'j.doe@acme.com',
      'janed@acme.com',
      'hello@acme.com',
      'contact@acme.com',
      'info@acme.com',
    ]);
  });

  it('uses only the first and last parts of a multi-word name, ignoring middle names', () => {
    const guesses = generateEmailGuesses('Jane Middle Doe', 'acme.com');

    expect(guesses[0]).toBe('jane@acme.com');
    expect(guesses[1]).toBe('jane.doe@acme.com');
  });

  it('falls back to a first-name-only guess plus the generic addresses when only a first name is known', () => {
    const guesses = generateEmailGuesses('Jane', 'acme.com');

    expect(guesses).toEqual(['jane@acme.com', 'hello@acme.com', 'contact@acme.com', 'info@acme.com']);
  });

  it('falls back to only the generic role addresses when no contact name is known', () => {
    const guesses = generateEmailGuesses(null, 'acme.com');

    expect(guesses).toEqual(['hello@acme.com', 'contact@acme.com', 'info@acme.com']);
  });

  it('falls back to only the generic role addresses when the contact name is blank/whitespace', () => {
    const guesses = generateEmailGuesses('   ', 'acme.com');

    expect(guesses).toEqual(['hello@acme.com', 'contact@acme.com', 'info@acme.com']);
  });

  it('strips apostrophes and hyphens from a name without producing a malformed address', () => {
    const guesses = generateEmailGuesses("Mary-Jane O'Brien", 'acme.com');

    expect(guesses[0]).toBe('maryjane@acme.com');
    expect(guesses[1]).toBe('maryjane.obrien@acme.com');
    expect(guesses.every((guess) => /^[a-z0-9.]+@acme\.com$/.test(guess))).toBe(true);
  });

  it('strips diacritics from a name (é -> e) rather than producing a non-ASCII address', () => {
    const guesses = generateEmailGuesses('José García', 'acme.com');

    expect(guesses[0]).toBe('jose@acme.com');
    expect(guesses[1]).toBe('jose.garcia@acme.com');
  });

  it('lowercases and normalizes a mixed-case domain', () => {
    const guesses = generateEmailGuesses(null, 'ACME.com');

    expect(guesses).toEqual(['hello@acme.com', 'contact@acme.com', 'info@acme.com']);
  });

  it('returns an empty array when the domain is blank, regardless of contact name', () => {
    expect(generateEmailGuesses('Jane Doe', '')).toEqual([]);
    expect(generateEmailGuesses('Jane Doe', '   ')).toEqual([]);
  });
});
