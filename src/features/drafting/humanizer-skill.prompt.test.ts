import { describe, expect, it } from 'vitest';

import { HUMANIZER_SKILL_INSTRUCTIONS } from './humanizer-skill.prompt';

describe('HUMANIZER_SKILL_INSTRUCTIONS', () => {
  it('states the hard no-invention rule, so a rewrite can never add facts the source lacks', () => {
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toMatch(/never invent facts/i);
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toMatch(/no fact, name,\s*number, date, quote, or citation absent/);
  });

  it('names concrete overused-vocabulary fixes so a future edit gutting the content is caught', () => {
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toContain('tapestry');
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toContain('delve into');
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toContain('leverage');
  });

  it('names structural tells: em-dash overuse and negative parallelism', () => {
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toMatch(/em-dash overuse/i);
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toMatch(/not only X but also Y/);
  });

  it('names vague, unsourced attribution as a pattern to fix', () => {
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toMatch(/experts argue.*observers cite/i);
  });

  it('names all five documented pattern categories from the upstream skill', () => {
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toContain('Content patterns');
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toContain('Language and grammar patterns');
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toContain('Style patterns');
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toContain('Communication patterns');
    expect(HUMANIZER_SKILL_INSTRUCTIONS).toContain('Filler and hedging patterns');
  });
});
