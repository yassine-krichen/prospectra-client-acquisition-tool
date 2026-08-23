import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  GOOGLE_PLACES_API_KEY: undefined as string | undefined,
  BUILTWITH_API_KEY: undefined as string | undefined,
  COMPANIES_HOUSE_API_KEY: undefined as string | undefined,
  TEXAS_COMPTROLLER_API_KEY: undefined as string | undefined,
  PRODUCT_HUNT_API_TOKEN: undefined as string | undefined,
  CRUNCHBASE_API_KEY: undefined as string | undefined,
  GITHUB_TOKEN: undefined as string | undefined,
  HUNTER_API_KEY: 'hunter-key' as string | undefined,
  PEOPLE_DATA_LABS_API_KEY: undefined as string | undefined,
  GEMINI_API_KEY: undefined as string | undefined,
  GROQ_API_KEY: undefined as string | undefined,
  DEEPSEEK_API_KEY: undefined as string | undefined,
  CLAUDE_BRIDGE_URL: undefined as string | undefined,
  RESEND_API_KEY: undefined as string | undefined,
}));
vi.mock('@/common/config/env', () => ({ env: envMock }));

const queryRawMock = vi.fn();
const groupByMock = vi.fn();
vi.mock('@/common/db/client', () => ({
  prisma: {
    $queryRaw: queryRawMock,
    prospect: { groupBy: groupByMock },
  },
}));

const isBridgeInCooldownMock = vi.fn();
vi.mock('@/features/drafting/bridge-budget', () => ({ isBridgeInCooldown: isBridgeInCooldownMock }));

const getEffectiveDailyCapMock = vi.fn();
const isDomainVerifiedMock = vi.fn();
vi.mock('@/features/sending/domain-verification-gate', () => ({
  getEffectiveDailyCap: getEffectiveDailyCapMock,
  isDomainVerified: isDomainVerifiedMock,
}));

const getTodaysSendCountMock = vi.fn();
vi.mock('@/features/sending/daily-send-counter', () => ({ getTodaysSendCount: getTodaysSendCountMock }));

const getNeonUsageMock = vi.fn();
vi.mock('@/features/system/neon-usage.service', () => ({ getNeonUsage: getNeonUsageMock }));

const getHunterAccountUsageMock = vi.fn();
vi.mock('@/features/enrichment/hunter-account.service', () => ({ getHunterAccountUsage: getHunterAccountUsageMock }));

const { getSystemHealth } = await import('./system-health.service');

const NOT_CONFIGURED_NEON_USAGE = {
  configured: false,
  storageUsedMB: null,
  storageLimitMB: null,
  storagePercentUsed: null,
  computeSecondsUsed: null,
  dataTransferMB: null,
  periodStart: null,
  periodEnd: null,
  error: null,
};

const CONFIGURED_HUNTER_USAGE = {
  configured: true,
  planName: 'Free',
  used: 5,
  available: 50,
  remaining: 45,
  resetDate: '2026-08-24',
  error: null,
};

function setDefaults(): void {
  queryRawMock.mockResolvedValue([{ size_bytes: BigInt(10 * 1024 * 1024) }]);
  groupByMock.mockResolvedValue([{ status: 'new', _count: { status: 3 } }]);
  isBridgeInCooldownMock.mockResolvedValue(false);
  getEffectiveDailyCapMock.mockReturnValue(3);
  isDomainVerifiedMock.mockReturnValue(false);
  getTodaysSendCountMock.mockResolvedValue(0);
  getNeonUsageMock.mockResolvedValue(NOT_CONFIGURED_NEON_USAGE);
  getHunterAccountUsageMock.mockResolvedValue(CONFIGURED_HUNTER_USAGE);
}

describe('getSystemHealth', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports database size in MB from its own query', async () => {
    setDefaults();

    const health = await getSystemHealth();

    expect(health.database).toEqual({ reachable: true, sizeMB: 10 });
  });

  it('reports reachable: false without throwing when the DB query fails', async () => {
    setDefaults();
    queryRawMock.mockRejectedValue(new Error('connection refused'));

    const health = await getSystemHealth();

    expect(health.database).toEqual({ reachable: false, sizeMB: null });
  });

  it('passes through Neon usage as-is, including when not configured', async () => {
    setDefaults();

    const health = await getSystemHealth();

    expect(health.neon).toEqual(NOT_CONFIGURED_NEON_USAGE);
  });

  it('passes through real Neon usage data when configured', async () => {
    setDefaults();
    const realUsage = { ...NOT_CONFIGURED_NEON_USAGE, configured: true, storageUsedMB: 38.23, storageLimitMB: 512 };
    getNeonUsageMock.mockResolvedValue(realUsage);

    const health = await getSystemHealth();

    expect(health.neon).toEqual(realUsage);
  });

  it('passes through Hunter account usage as-is, straight from the live account service', async () => {
    setDefaults();

    const health = await getSystemHealth();

    expect(health.hunter).toEqual(CONFIGURED_HUNTER_USAGE);
  });

  it('passes through Hunter as unconfigured when the account service reports it unconfigured', async () => {
    setDefaults();
    getHunterAccountUsageMock.mockResolvedValue({
      configured: false,
      planName: null,
      used: null,
      available: null,
      remaining: null,
      resetDate: null,
      error: null,
    });

    const health = await getSystemHealth();

    expect(health.hunter.configured).toBe(false);
  });

  it('fills every ProspectStatus with 0 by default, not just statuses with rows', async () => {
    setDefaults();
    groupByMock.mockResolvedValue([{ status: 'sent', _count: { status: 2 } }]);

    const health = await getSystemHealth();

    expect(health.prospectFunnel.sent).toBe(2);
    expect(health.prospectFunnel.new).toBe(0);
    expect(health.prospectFunnel.won).toBe(0);
    expect(Object.keys(health.prospectFunnel)).toContain('unsubscribed');
  });

  it('reports configuredServices from whether each optional env var is set', async () => {
    setDefaults();
    envMock.RESEND_API_KEY = 're_abc';

    const health = await getSystemHealth();

    expect(health.configuredServices.resend).toBe(true);
    expect(health.configuredServices.googlePlaces).toBe(false);
    expect(health.configuredServices.hunter).toBe(true);

    envMock.RESEND_API_KEY = undefined;
  });

  it('reports configuredPercent as 0 when nothing is configured', async () => {
    setDefaults();
    for (const key of Object.keys(envMock) as Array<keyof typeof envMock>) {
      envMock[key] = undefined;
    }

    const health = await getSystemHealth();

    expect(health.configuredPercent).toBe(0);

    envMock.HUNTER_API_KEY = 'hunter-key';
  });

  it('reports configuredPercent as 100 when every optional service has a key', async () => {
    setDefaults();
    for (const key of Object.keys(envMock) as Array<keyof typeof envMock>) {
      envMock[key] = 'some-value';
    }

    const health = await getSystemHealth();

    expect(health.configuredPercent).toBe(100);

    for (const key of Object.keys(envMock) as Array<keyof typeof envMock>) {
      envMock[key] = undefined;
    }
    envMock.HUNTER_API_KEY = 'hunter-key';
  });

  it('reports configuredPercent as a rounded percentage of configured services out of the total', async () => {
    setDefaults();
    // 1 of 14 tracked services (HUNTER_API_KEY, set by setDefaults) configured.
    const health = await getSystemHealth();

    expect(health.configuredPercent).toBe(Math.round((1 / 14) * 100));
  });

  it('passes through domain verification, sent-today count, daily cap, and bridge cooldown as-is', async () => {
    setDefaults();
    isDomainVerifiedMock.mockReturnValue(true);
    getEffectiveDailyCapMock.mockReturnValue(60);
    getTodaysSendCountMock.mockResolvedValue(12);
    isBridgeInCooldownMock.mockResolvedValue(true);

    const health = await getSystemHealth();

    expect(health.sending).toEqual({ domainVerified: true, sentToday: 12, dailyCap: 60 });
    expect(health.bridgeInCooldown).toBe(true);
  });
});
