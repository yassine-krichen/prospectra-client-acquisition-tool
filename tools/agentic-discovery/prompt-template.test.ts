import { describe, expect, it } from 'vitest';

import { buildDiscoveryPrompt } from './prompt-template';

describe('buildDiscoveryPrompt', () => {
  it('includes category, geography, and count in the prompt', () => {
    const prompt = buildDiscoveryPrompt({ category: 'dental', geography: 'Brooklyn, NY', count: 5 });

    expect(prompt).toContain('"Brooklyn, NY"');
    expect(prompt).toContain('"dental"');
    expect(prompt).toContain('Find up to 5 qualifying companies');
  });

  it('omits the preference section entirely when no preference is given', () => {
    const prompt = buildDiscoveryPrompt({ category: 'dental', geography: 'Brooklyn, NY', count: 5 });

    expect(prompt).not.toContain('Job-size preference');
  });

  it('appends the preference section when a preference is given', () => {
    const prompt = buildDiscoveryPrompt({
      category: 'dental',
      geography: 'Brooklyn, NY',
      count: 5,
      preference: 'Prefer quick wins like landing page refreshes.',
    });

    expect(prompt).toContain('## Job-size preference (soft, not a hard filter)');
    expect(prompt).toContain('Prefer quick wins like landing page refreshes.');
  });

  it('frames the preference as soft, never a reason to discard a strong signal', () => {
    const prompt = buildDiscoveryPrompt({
      category: 'dental',
      geography: 'Brooklyn, NY',
      count: 5,
      preference: 'Prefer quick wins.',
    });

    expect(prompt).toContain(
      'Still report any qualifying prospect regardless of job size or type',
    );
  });

  it('omits the preference section for an empty-string preference', () => {
    const prompt = buildDiscoveryPrompt({
      category: 'dental',
      geography: 'Brooklyn, NY',
      count: 5,
      preference: '',
    });

    expect(prompt).not.toContain('Job-size preference');
  });

  it('adds no track section when no track is given', () => {
    const prompt = buildDiscoveryPrompt({ category: 'dental', geography: 'Brooklyn, NY', count: 5 });

    expect(prompt).not.toContain('## Track:');
  });

  it('khalid track asks for small local businesses and requires phone and address', () => {
    const prompt = buildDiscoveryPrompt({ category: 'roofing', geography: 'Queens, NY', count: 5, track: 'khalid' });

    expect(prompt).toContain('## Track: local walk-in / phone outreach');
    expect(prompt).toContain('Phone number AND street address are REQUIRED');
    expect(prompt).not.toContain('## Track: cold email');
  });

  it('voreon track asks for tiered cold-email prospects with a named decision-maker', () => {
    const prompt = buildDiscoveryPrompt({ category: 'dental', geography: 'Brooklyn, NY', count: 5, track: 'voreon' });

    expect(prompt).toContain('## Track: cold email, web/software studio');
    expect(prompt).toContain('"[LANDING]" or "[BIGGER]"');
    expect(prompt).not.toContain('## Track: local walk-in');
  });
});
