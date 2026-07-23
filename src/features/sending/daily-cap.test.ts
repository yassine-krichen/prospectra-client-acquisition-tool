import { beforeEach, describe, expect, it, vi } from 'vitest';

// getWarmupRampCap is a scheduling input only, consulted by
// domain-verification-gate.ts (own dedicated test suite) exclusively once
// the domain is verified. This suite covers its own date-math and fallback
// behavior in isolation.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { DOMAIN_WARMUP_START_DATE: undefined as string | undefined },
}));

vi.mock('@/common/config/env', () => ({ env: mockEnv }));

const { getWarmupRampCap } = await import('./daily-cap');

const WARMUP_START = '2026-01-01T00:00:00.000Z';

beforeEach(() => {
  mockEnv.DOMAIN_WARMUP_START_DATE = undefined;
});

describe('getWarmupRampCap', () => {
  it('falls back to the week-1 cap (12) when DOMAIN_WARMUP_START_DATE is unset', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = undefined;

    expect(getWarmupRampCap(new Date('2026-06-01T00:00:00.000Z'))).toBe(12);
  });

  it('returns the week-1 cap (12) for days 0-6 since warmup start', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = WARMUP_START;

    expect(getWarmupRampCap(new Date('2026-01-01T00:00:00.000Z'))).toBe(12); // day 0
    expect(getWarmupRampCap(new Date('2026-01-07T23:59:59.999Z'))).toBe(12); // day 6, just before day 7
  });

  it('returns the week-2 cap (25) for days 7-13 since warmup start', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = WARMUP_START;

    expect(getWarmupRampCap(new Date('2026-01-08T00:00:00.000Z'))).toBe(25); // day 7
    expect(getWarmupRampCap(new Date('2026-01-14T23:59:59.999Z'))).toBe(25); // day 13
  });

  it('returns the week-3 cap (40) for days 14-20 since warmup start', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = WARMUP_START;

    expect(getWarmupRampCap(new Date('2026-01-15T00:00:00.000Z'))).toBe(40);
  });

  it('returns the week-4 cap (60) for days 21-27 since warmup start', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = WARMUP_START;

    expect(getWarmupRampCap(new Date('2026-01-22T00:00:00.000Z'))).toBe(60);
  });

  it('returns the steady-state week-5+ cap (100) from day 28 onward, and holds it indefinitely rather than growing further', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = WARMUP_START;

    expect(getWarmupRampCap(new Date('2026-01-29T00:00:00.000Z'))).toBe(100); // day 28
    expect(getWarmupRampCap(new Date('2027-06-01T00:00:00.000Z'))).toBe(100); // over a year later
  });

  it('falls back to the week-1 cap for a malformed DOMAIN_WARMUP_START_DATE instead of throwing', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = 'not-a-real-date';

    expect(() => getWarmupRampCap(new Date('2026-06-01T00:00:00.000Z'))).not.toThrow();
    expect(getWarmupRampCap(new Date('2026-06-01T00:00:00.000Z'))).toBe(12);
  });

  it('falls back to the week-1 cap for a future-dated DOMAIN_WARMUP_START_DATE rather than a larger ramp cap', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = '2030-01-01T00:00:00.000Z';

    expect(getWarmupRampCap(new Date('2026-06-01T00:00:00.000Z'))).toBe(12);
  });

  it('defaults referenceDate to now when not given', () => {
    mockEnv.DOMAIN_WARMUP_START_DATE = undefined;

    expect(getWarmupRampCap()).toBe(12);
  });
});
