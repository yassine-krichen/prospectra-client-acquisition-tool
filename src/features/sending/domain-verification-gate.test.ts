import { beforeEach, describe, expect, it, vi } from 'vitest';

// domain-verification-gate.ts is THE hard gate on real send volume: no
// caller may pass any argument that overrides its result, so `env` and
// `daily-cap.ts`'s getWarmupRampCap are mocked directly here to prove the
// override logic in isolation from env-parsing (env.test.ts) and the ramp
// schedule's own date math (daily-cap.test.ts).
const { mockEnv, getWarmupRampCapMock } = vi.hoisted(() => ({
  mockEnv: { DOMAIN_DNS_VERIFIED: false, DAILY_SEND_CAP_TEST: 3 },
  getWarmupRampCapMock: vi.fn(),
}));

vi.mock('@/common/config/env', () => ({ env: mockEnv }));
vi.mock('@/features/sending/daily-cap', () => ({ getWarmupRampCap: getWarmupRampCapMock }));

const { getEffectiveDailyCap, isDomainVerified } = await import('./domain-verification-gate');

beforeEach(() => {
  mockEnv.DOMAIN_DNS_VERIFIED = false;
  mockEnv.DAILY_SEND_CAP_TEST = 3;
  getWarmupRampCapMock.mockReset();
});

describe('getEffectiveDailyCap', () => {
  it('returns DAILY_SEND_CAP_TEST, never the warmup ramp cap, while the domain is unverified — even when the ramp would allow far more volume', () => {
    mockEnv.DOMAIN_DNS_VERIFIED = false;
    mockEnv.DAILY_SEND_CAP_TEST = 3;
    getWarmupRampCapMock.mockReturnValue(100); // stubbed high ramp value that must NOT leak through

    expect(getEffectiveDailyCap()).toBe(3);
  });

  it('never even consults the warmup ramp while the domain is unverified', () => {
    mockEnv.DOMAIN_DNS_VERIFIED = false;
    getWarmupRampCapMock.mockReturnValue(100);

    getEffectiveDailyCap();

    expect(getWarmupRampCapMock).not.toHaveBeenCalled();
  });

  it('reflects whatever DAILY_SEND_CAP_TEST is currently set to while unverified', () => {
    mockEnv.DOMAIN_DNS_VERIFIED = false;
    mockEnv.DAILY_SEND_CAP_TEST = 7;

    expect(getEffectiveDailyCap()).toBe(7);
  });

  it('returns the warmup ramp cap instead of DAILY_SEND_CAP_TEST once the domain is verified', () => {
    mockEnv.DOMAIN_DNS_VERIFIED = true;
    mockEnv.DAILY_SEND_CAP_TEST = 3;
    getWarmupRampCapMock.mockReturnValue(25);

    expect(getEffectiveDailyCap()).toBe(25);
  });

  it('takes no arguments, so no caller can pass a parameter to override the gate result', () => {
    expect(getEffectiveDailyCap.length).toBe(0);
  });
});

describe('isDomainVerified', () => {
  it('returns the current DOMAIN_DNS_VERIFIED value for display purposes', () => {
    mockEnv.DOMAIN_DNS_VERIFIED = true;
    expect(isDomainVerified()).toBe(true);

    mockEnv.DOMAIN_DNS_VERIFIED = false;
    expect(isDomainVerified()).toBe(false);
  });

  it('has no side effect on what getEffectiveDailyCap subsequently returns', () => {
    mockEnv.DOMAIN_DNS_VERIFIED = false;
    mockEnv.DAILY_SEND_CAP_TEST = 3;
    getWarmupRampCapMock.mockReturnValue(100);

    isDomainVerified();
    isDomainVerified();

    expect(getEffectiveDailyCap()).toBe(3);
  });
});
