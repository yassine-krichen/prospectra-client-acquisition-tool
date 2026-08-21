import { describe, expect, it } from 'vitest';

import { isPriorityMarket, PRIORITY_MARKETS } from '@/features/discovery/priority-markets';

describe('isPriorityMarket', () => {
  it('matches a US state abbreviation embedded in a free-text geography string', () => {
    expect(isPriorityMarket('Austin, TX')).toBe(true);
  });

  it('matches a full US state name', () => {
    expect(isPriorityMarket('Denver, Colorado')).toBe(true);
  });

  it('matches a European country by its listed abbreviation', () => {
    expect(isPriorityMarket('London, UK')).toBe(true);
  });

  it('matches a European country via a common alternate name', () => {
    expect(isPriorityMarket('Berlin, Germany')).toBe(true);
    expect(isPriorityMarket('Manchester, England')).toBe(true);
  });

  it('does not match a geography with no priority-market mention', () => {
    expect(isPriorityMarket('Toronto, Canada')).toBe(false);
  });

  it('does not false-positive a short state abbreviation appearing inside an unrelated word', () => {
    // "Casablanca" contains "ca" but is not a mention of California.
    expect(isPriorityMarket('Casablanca, Morocco')).toBe(false);
  });

  it('does not false-positive a priority state name embedded inside a distinct, non-priority state name', () => {
    // "West Virginia" is a real, separate, non-priority state - it must not
    // score as a match just because "Virginia" is a substring of its name.
    expect(isPriorityMarket('Charleston, West Virginia')).toBe(false);
  });

  it('returns false for undefined/empty geography rather than throwing', () => {
    expect(isPriorityMarket(undefined)).toBe(false);
    expect(isPriorityMarket('')).toBe(false);
  });

  it('exports the documented list of US states and European countries', () => {
    expect(PRIORITY_MARKETS).toContain('Texas');
    expect(PRIORITY_MARKETS).toContain('UK');
    expect(PRIORITY_MARKETS.length).toBe(24);
  });
});
