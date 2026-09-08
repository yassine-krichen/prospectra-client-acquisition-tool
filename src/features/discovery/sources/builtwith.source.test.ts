import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` guarantees `envMock` is initialized before `vi.mock`'s factory
// (itself hoisted above this file's imports) ever runs.
const envMock = vi.hoisted(() => ({
  BUILTWITH_API_KEY: 'test-builtwith-key' as string | undefined,
  BUILTWITH_MONTHLY_CAP: 100,
}));
vi.mock('@/common/config/env', () => ({ env: envMock }));

// In-memory fake, NOT a real database - same rationale and shape as the
// equivalent mock in peopledatalabs.source.test.ts (this file's quota-gate
// counterpart): Postgres's atomic `UPDATE ... WHERE count < cap` race-safety
// is already exercised for real against TEST_DATABASE_URL in
// hunter.source.test.ts for the identical pattern, so this suite only needs
// to prove the gating logic itself, not re-prove the atomicity.
const usageState = vi.hoisted(() => ({ count: 0 }));
interface UpdateManyArgs {
  where: { count: { lt?: number; gt?: number } };
  data: { count: { increment?: number; decrement?: number } };
}
vi.mock('@/common/db/client', () => ({
  prisma: {
    apiUsageCounter: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn(async ({ where, data }: UpdateManyArgs) => {
        if (where.count.lt !== undefined) {
          if (usageState.count >= where.count.lt) return { count: 0 };
          usageState.count += data.count.increment ?? 0;
          return { count: 1 };
        }
        if (where.count.gt !== undefined) {
          if (usageState.count <= where.count.gt) return { count: 0 };
          usageState.count -= data.count.decrement ?? 0;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  },
}));

import { lookupStaleStack } from './builtwith.source';

function mockFetchJson(body: unknown, options: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('lookupStaleStack', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.BUILTWITH_API_KEY = 'test-builtwith-key';
    envMock.BUILTWITH_MONTHLY_CAP = 100;
    usageState.count = 0;
  });

  it('reports source unavailable and never calls fetch when BUILTWITH_API_KEY is not configured', async () => {
    envMock.BUILTWITH_API_KEY = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await lookupStaleStack('acme.com');

    expect(result).toEqual({ ok: false, reason: 'source unavailable: BUILTWITH_API_KEY not configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('looks up technologies successfully when under the monthly cap', async () => {
    mockFetchJson({ Results: [{ Result: { Paths: [{ Technologies: [{ Name: 'jQuery' }] }] } }] });

    const result = await lookupStaleStack('acme.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(['jQuery']);
  });

  it('refuses to call BuiltWith at all once the monthly cap is already used', async () => {
    envMock.BUILTWITH_MONTHLY_CAP = 1;
    usageState.count = 1; // already at the cap
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await lookupStaleStack('acme.com');

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: BuiltWith monthly cap (1/month) already used this month',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rolls the reserved quota unit back when the network request throws, so a dead network never permanently burns quota', async () => {
    envMock.BUILTWITH_MONTHLY_CAP = 5;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await lookupStaleStack('acme.com');

    expect(usageState.count).toBe(0);
  });

  it('does NOT roll back the reserved quota unit on a non-2xx response, since BuiltWith already received and likely billed the request', async () => {
    envMock.BUILTWITH_MONTHLY_CAP = 5;
    mockFetchJson({}, { ok: false, status: 500 });

    await lookupStaleStack('acme.com');

    expect(usageState.count).toBe(1);
  });
});
