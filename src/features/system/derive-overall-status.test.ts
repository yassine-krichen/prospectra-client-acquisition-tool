import { describe, expect, it } from 'vitest';

import { deriveOverallStatus } from './derive-overall-status';
import type { SystemHealth } from './system-health.service';

function baseHealth(overrides: Partial<SystemHealth> = {}): SystemHealth {
  return {
    database: { reachable: true, sizeMB: 10, limitMB: 512, percentUsed: 2 },
    hunter: { configured: true, used: 5, cap: 25, remaining: 20 },
    sending: { domainVerified: false, sentToday: 0, dailyCap: 3 },
    bridgeInCooldown: false,
    configuredServices: {
      googlePlaces: false,
      builtwith: false,
      productHunt: false,
      crunchbase: false,
      github: false,
      hunter: true,
      peopleDataLabs: false,
      gemini: false,
      groq: false,
      deepseek: false,
      claudeBridge: false,
      resend: false,
    },
    prospectFunnel: {},
    ...overrides,
  };
}

describe('deriveOverallStatus', () => {
  it('returns unknown when health has not loaded yet', () => {
    expect(deriveOverallStatus(null)).toBe('unknown');
  });

  it('returns ok when nothing is near a limit', () => {
    expect(deriveOverallStatus(baseHealth())).toBe('ok');
  });

  it('returns critical when the database is unreachable', () => {
    expect(
      deriveOverallStatus(baseHealth({ database: { reachable: false, sizeMB: null, limitMB: 512, percentUsed: null } }))
    ).toBe('critical');
  });

  it('returns critical when database storage is at or above 95%', () => {
    expect(deriveOverallStatus(baseHealth({ database: { reachable: true, sizeMB: 490, limitMB: 512, percentUsed: 95.7 } }))).toBe(
      'critical'
    );
  });

  it('returns warning (not critical) when database storage is at 75-94%', () => {
    expect(deriveOverallStatus(baseHealth({ database: { reachable: true, sizeMB: 400, limitMB: 512, percentUsed: 78 } }))).toBe(
      'warning'
    );
  });

  it('returns warning when Hunter quota has 3 or fewer searches remaining', () => {
    expect(deriveOverallStatus(baseHealth({ hunter: { configured: true, used: 23, cap: 25, remaining: 2 } }))).toBe('warning');
  });

  it('does not warn on Hunter quota when Hunter is not configured at all', () => {
    expect(
      deriveOverallStatus(baseHealth({ hunter: { configured: false, used: 0, cap: null, remaining: null } }))
    ).toBe('ok');
  });

  it('returns warning when the claude bridge is in cooldown', () => {
    expect(deriveOverallStatus(baseHealth({ bridgeInCooldown: true }))).toBe('warning');
  });

  it('returns warning when today\'s sends have hit the daily cap', () => {
    expect(deriveOverallStatus(baseHealth({ sending: { domainVerified: false, sentToday: 3, dailyCap: 3 } }))).toBe(
      'warning'
    );
  });
});
