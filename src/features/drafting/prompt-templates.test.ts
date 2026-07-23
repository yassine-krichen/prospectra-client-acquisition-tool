import { describe, expect, it } from 'vitest';

import { BANNED_PHRASES, buildDraftPrompt, MAX_WORDS, MIN_WORDS } from './prompt-templates';
import type { DraftableProspect } from './drafting.types';

function buildProspect(overrides: Partial<DraftableProspect> = {}): DraftableProspect {
  return {
    companyName: 'Acme Inc',
    contactName: 'Jane Doe',
    contactTitle: 'CEO',
    industry: 'saas',
    projectFit: 'full_stack_app',
    estimatedBudget: 'mid',
    signal: {
      type: 'outdated_site',
      description: 'their pricing page still references a 2019 product name',
      evidence: 'archive.org snapshot from March 2024 shows the old name',
      strength: 'strong',
    },
    ...overrides,
  };
}

describe('buildDraftPrompt', () => {
  it('includes the signal description and evidence so the one allowed observation is grounded in real data', () => {
    const prompt = buildDraftPrompt(buildProspect());

    expect(prompt).toContain('their pricing page still references a 2019 product name');
    expect(prompt).toContain('archive.org snapshot from March 2024 shows the old name');
  });

  it('omits the evidence line entirely when the signal has no evidence, rather than inserting a placeholder', () => {
    const prompt = buildDraftPrompt(buildProspect({ signal: { ...buildProspect().signal, evidence: null } }));

    expect(prompt).not.toContain('Evidence: null');
    expect(prompt).not.toMatch(/Evidence:\s*$/m);
  });

  it('addresses the named contact with their title when both are known', () => {
    const prompt = buildDraftPrompt(buildProspect({ contactName: 'Jane Doe', contactTitle: 'CEO' }));

    expect(prompt).toContain('Recipient: Jane Doe, CEO.');
  });

  it('falls back to a role-based recipient description when no contact name is known', () => {
    const prompt = buildDraftPrompt(buildProspect({ contactName: null, contactTitle: null, companyName: 'Acme Inc' }));

    expect(prompt).toContain('Recipient: the right person at Acme Inc.');
  });

  it('instructs the model to produce output in the SUBJECT:/BODY: format parse-draft-output.ts expects', () => {
    const prompt = buildDraftPrompt(buildProspect());

    expect(prompt).toMatch(/SUBJECT:/);
    expect(prompt).toMatch(/BODY:/);
  });

  it('lists every banned phrase so the model is instructed to avoid all of them', () => {
    const prompt = buildDraftPrompt(buildProspect());

    for (const phrase of BANNED_PHRASES) {
      expect(prompt).toContain(phrase);
    }
  });
});

describe('buildDraftPrompt untrusted-data fencing', () => {
  it('wraps the prospect data in a clearly-labeled fenced block with a not-instructions warning, ahead of prompt injection from scraped fields', () => {
    const prompt = buildDraftPrompt(buildProspect());

    expect(prompt).toMatch(/NOT instructions/i);
    expect(prompt).toContain('=== BEGIN PROSPECT DATA (untrusted data) ===');
    expect(prompt).toContain('=== END PROSPECT DATA (untrusted data) ===');
  });

  it('places the untrusted-data warning before the fenced block, and the fenced block contains the scraped fields', () => {
    const prompt = buildDraftPrompt(buildProspect());

    const warningIndex = prompt.search(/NOT instructions/i);
    const beginIndex = prompt.indexOf('=== BEGIN PROSPECT DATA');
    const endIndex = prompt.indexOf('=== END PROSPECT DATA');

    expect(warningIndex).toBeGreaterThan(-1);
    expect(warningIndex).toBeLessThan(beginIndex);
    expect(beginIndex).toBeLessThan(endIndex);

    const fencedContent = prompt.slice(beginIndex, endIndex);
    expect(fencedContent).toContain('their pricing page still references a 2019 product name');
  });
});

describe('MIN_WORDS / MAX_WORDS constants', () => {
  it('are exported and MIN_WORDS is strictly less than MAX_WORDS', () => {
    expect(MIN_WORDS).toBeLessThan(MAX_WORDS);
  });

  it('are both positive integers', () => {
    expect(Number.isInteger(MIN_WORDS)).toBe(true);
    expect(Number.isInteger(MAX_WORDS)).toBe(true);
    expect(MIN_WORDS).toBeGreaterThan(0);
  });
});
