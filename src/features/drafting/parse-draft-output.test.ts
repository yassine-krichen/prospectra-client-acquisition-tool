import { describe, expect, it } from 'vitest';

import { parseDraftOutput } from './parse-draft-output';

describe('parseDraftOutput', () => {
  it('splits a well-formed SUBJECT:/BODY: single-line response into subject and body', () => {
    const raw = 'SUBJECT: Quick question about your pricing page\nBODY: Hi Jane, worth a quick chat?';

    const result = parseDraftOutput(raw);

    expect(result).toEqual({
      subject: 'Quick question about your pricing page',
      body: 'Hi Jane, worth a quick chat?',
    });
  });

  it('converts escaped \\n sequences in the body into real newlines', () => {
    const raw = 'SUBJECT: Hello\nBODY: First paragraph.\\nSecond paragraph.\\nThird paragraph.';

    const result = parseDraftOutput(raw);

    expect(result?.body).toBe('First paragraph.\nSecond paragraph.\nThird paragraph.');
  });

  it('preserves real (non-escaped) multi-line bodies that already span several lines', () => {
    const raw = 'SUBJECT: Hello\nBODY: First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';

    const result = parseDraftOutput(raw);

    expect(result?.body).toBe('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
  });

  it('trims surrounding whitespace from both subject and body', () => {
    const raw = 'SUBJECT:   Padded subject   \nBODY:   Padded body   ';

    const result = parseDraftOutput(raw);

    expect(result).toEqual({ subject: 'Padded subject', body: 'Padded body' });
  });

  it('is case-insensitive about the SUBJECT/BODY markers', () => {
    const raw = 'subject: lowercase marker\nbody: still works';

    const result = parseDraftOutput(raw);

    expect(result).toEqual({ subject: 'lowercase marker', body: 'still works' });
  });

  it('tolerates extra text before and after the two required lines', () => {
    const raw = 'Sure, here you go:\n\nSUBJECT: My subject\nBODY: My body text.\n\nLet me know if you want changes!';

    const result = parseDraftOutput(raw);

    expect(result?.subject).toBe('My subject');
    expect(result?.body).toContain('My body text.');
  });

  it('returns null instead of throwing when the SUBJECT: marker is missing', () => {
    const raw = 'BODY: A body with no subject line at all.';

    expect(parseDraftOutput(raw)).toBeNull();
  });

  it('returns null instead of throwing when the BODY: marker is missing', () => {
    const raw = 'SUBJECT: A subject with no body line at all.';

    expect(parseDraftOutput(raw)).toBeNull();
  });

  it('returns null instead of throwing on completely unstructured model output', () => {
    const raw = 'I refuse to write this email because it violates my policies.';

    expect(parseDraftOutput(raw)).toBeNull();
  });

  it('returns null when the subject value is present but empty', () => {
    // The SUBJECT: marker sits last with only trailing whitespace after it,
    // so its captured group trims down to an empty string.
    const raw = 'BODY: A valid body.\nSUBJECT:   ';

    expect(parseDraftOutput(raw)).toBeNull();
  });

  it('returns null when the body value is present but empty', () => {
    const raw = 'SUBJECT: A valid subject.\nBODY:   ';

    expect(parseDraftOutput(raw)).toBeNull();
  });

  it('returns null rather than crashing on an empty string input', () => {
    expect(parseDraftOutput('')).toBeNull();
  });
});
