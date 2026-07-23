import { describe, expect, it } from 'vitest';

import { detectStaleStackSignal } from './stale-stack-rules';

describe('detectStaleStackSignal', () => {
  it('returns null for an empty technology list', () => {
    expect(detectStaleStackSignal([])).toBeNull();
  });

  it('returns null for a modern stack with no legacy markers', () => {
    expect(detectStaleStackSignal(['React 18.2.0', 'Next.js 14.0.0'])).toBeNull();
  });

  it('flags jQuery 1.x as a strong EOL signal', () => {
    const match = detectStaleStackSignal(['jQuery 1.9.1']);

    expect(match?.strength).toBe('strong');
    expect(match?.description).toMatch(/1\.x/);
  });

  it('flags jQuery 1.x as a strong EOL signal even at a low minor version', () => {
    const match = detectStaleStackSignal(['jQuery 1.0.0']);

    expect(match?.strength).toBe('strong');
  });

  it('flags jQuery 2.x as a medium EOL signal', () => {
    const match = detectStaleStackSignal(['jQuery 2.2.4']);

    expect(match?.strength).toBe('medium');
    expect(match?.description).toMatch(/2\.x/);
  });

  it('does not flag jQuery 3.x, since it is still actively maintained', () => {
    expect(detectStaleStackSignal(['jQuery 3.6.0'])).toBeNull();
  });

  it('flags jQuery with no reported version as a weak signal', () => {
    const match = detectStaleStackSignal(['jQuery']);

    expect(match?.strength).toBe('weak');
    expect(match?.description).toMatch(/without a reported version/i);
  });

  it('flags WordPress with no modern JS framework layered on top as a weak signal', () => {
    const match = detectStaleStackSignal(['WordPress 6.1']);

    expect(match?.strength).toBe('weak');
    expect(match?.description).toMatch(/WordPress/i);
  });

  it('does not flag WordPress when a modern JS framework is layered on top', () => {
    expect(detectStaleStackSignal(['WordPress 6.1', 'React 18.2.0'])).toBeNull();
  });

  it('returns the strongest match when multiple rules fire (jQuery 1.x over a WordPress theme)', () => {
    const match = detectStaleStackSignal(['jQuery 1.9.1', 'WordPress 6.1']);

    expect(match?.strength).toBe('strong');
    expect(match?.description).toMatch(/jQuery/i);
  });

  it('is case-insensitive when detecting jQuery, WordPress, and modern framework names', () => {
    const jqueryMatch = detectStaleStackSignal(['JQUERY 1.2.3']);
    expect(jqueryMatch?.strength).toBe('strong');

    const wordpressSuppressed = detectStaleStackSignal(['wordpress', 'VUE.JS 3']);
    expect(wordpressSuppressed).toBeNull();
  });
});
