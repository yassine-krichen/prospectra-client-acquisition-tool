import { describe, expect, it } from 'vitest';

import { deriveOverallStatus } from './derive-overall-status';
import type { SystemHealth } from './system-health.service';

function baseHealth(overrides: Partial<SystemHealth> = {}): SystemHealth {
  return {
    database: { reachable: true, sizeMB: 10 },
    neon: {
      configured: true,
      storageUsedMB: 10,
      storageLimitMB: 512,
      storagePercentUsed: 2,
      computeSecondsUsed: 100,
      dataTransferMB: 1,
      periodStart: '2026-08-01T00:00:00Z',
      periodEnd: '2026-09-01T00:00:00Z',
      error: null,
    },
    hunter: { configured: true, planName: 'Free', used: 5, available: 25, remaining: 20, resetDate: '2026-08-24', error: null },
    sending: { domainVerified: false, sentToday: 0, dailyCap: 3 },
    bridgeInCooldown: false,
    configuredServices: {
      googlePlaces: false,
      builtwith: false,
      companiesHouse: false,
      texasComptroller: false,
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
    configuredPercent: Math.round((1 / 14) * 100),
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
    expect(deriveOverallStatus(baseHealth({ database: { reachable: false, sizeMB: null } }))).toBe('critical');
  });

  it('returns critical when Neon-reported storage is at or above 95%', () => {
    expect(
      deriveOverallStatus(baseHealth({ neon: { ...baseHealth().neon, storagePercentUsed: 95.7 } }))
    ).toBe('critical');
  });

  it('returns warning (not critical) when Neon-reported storage is at 75-94%', () => {
    expect(deriveOverallStatus(baseHealth({ neon: { ...baseHealth().neon, storagePercentUsed: 78 } }))).toBe('warning');
  });

  it('does not warn on storage when Neon usage is not configured (percent is null)', () => {
    expect(
      deriveOverallStatus(
        baseHealth({
          neon: {
            configured: false,
            storageUsedMB: null,
            storageLimitMB: null,
            storagePercentUsed: null,
            computeSecondsUsed: null,
            dataTransferMB: null,
            periodStart: null,
            periodEnd: null,
            error: null,
          },
        })
      )
    ).toBe('ok');
  });

  it('returns warning when Hunter quota has 3 or fewer searches remaining', () => {
    expect(
      deriveOverallStatus(
        baseHealth({
          hunter: { configured: true, planName: 'Free', used: 23, available: 25, remaining: 2, resetDate: '2026-08-24', error: null },
        })
      )
    ).toBe('warning');
  });

  it('does not warn on Hunter quota when Hunter is not configured at all', () => {
    expect(
      deriveOverallStatus(
        baseHealth({
          hunter: { configured: false, planName: null, used: null, available: null, remaining: null, resetDate: null, error: null },
        })
      )
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
