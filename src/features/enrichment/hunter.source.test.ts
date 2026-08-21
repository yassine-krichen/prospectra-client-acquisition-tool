import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertDestructiveTestsAllowed } from '@/common/testing/require-destructive-test-guard';

// Only `HUNTER_API_KEY` is overridden per test below - `DATABASE_URL` and
// everything else must stay real, since this suite makes real Prisma calls
// against the real Postgres DB (via the un-mocked `prisma` import below,
// which itself reads `env.DATABASE_URL` to connect).
const envMock = vi.hoisted(() => ({ HUNTER_API_KEY: 'test-hunter-key' as string | undefined }));
vi.mock('@/common/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/config/env')>();
  return {
    env: {
      ...actual.env,
      get HUNTER_API_KEY() {
        return envMock.HUNTER_API_KEY;
      },
    },
  };
});

import { prisma } from '@/common/testing/test-db-client';

// Redirects every layer of `runHunterEnrichment`'s own call chain (not just
// this file's direct calls) to the isolated test database - see
// require-destructive-test-guard.ts.
vi.mock('@/common/db/client', async () => {
  const { prisma } = await import('@/common/testing/test-db-client');
  return { prisma };
});

import { runHunterEnrichment } from './hunter.source';

// Integration test against the real Postgres DB (see
// prospects.repository.test.ts's own doc comment) - only the external
// Hunter.io API call itself is mocked. This is the one piece of Branch C
// worth a real-DB test: the quota reservation race-safety comes from
// Postgres evaluating `count: { lt: cap }` as part of the UPDATE itself,
// which a mocked Prisma client can't meaningfully exercise.
const USAGE_SOURCE = 'hunter';
const MONTHLY_FREE_TIER_CAP = 50;

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

async function readUsageCount(): Promise<number | null> {
  const counter = await prisma.apiUsageCounter.findUnique({
    where: { source_yearMonth: { source: USAGE_SOURCE, yearMonth: currentYearMonth() } },
  });
  return counter?.count ?? null;
}

function mockFetchJson(body: unknown, options: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const input = { domain: 'acme.com', companyName: 'Acme Inc', contactName: null as string | null };

const domainSearchSuccessBody = {
  data: { emails: [{ value: 'jane@acme.com', confidence: 90, first_name: 'Jane', last_name: 'Doe' }] },
};

beforeAll(() => {
  assertDestructiveTestsAllowed('hunter.source.test.ts');
});

beforeEach(async () => {
  envMock.HUNTER_API_KEY = 'test-hunter-key';
  await prisma.apiUsageCounter.deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.apiUsageCounter.deleteMany();
  await prisma.$disconnect();
});

describe('runHunterEnrichment quota gate', () => {
  it('reports source unavailable and never calls fetch when HUNTER_API_KEY is not configured', async () => {
    envMock.HUNTER_API_KEY = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runHunterEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: HUNTER_API_KEY not configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readUsageCount()).toBeNull();
  });

  it('increments this month\'s usage counter by exactly one after a successful call', async () => {
    mockFetchJson(domainSearchSuccessBody);

    const result = await runHunterEnrichment(input);

    expect(result.ok).toBe(true);
    expect(await readUsageCount()).toBe(1);
  });

  it('creates the usage counter row starting at zero, then reserves one, on the first call of a new month', async () => {
    mockFetchJson(domainSearchSuccessBody);

    await runHunterEnrichment(input);

    const counter = await prisma.apiUsageCounter.findUnique({
      where: { source_yearMonth: { source: USAGE_SOURCE, yearMonth: currentYearMonth() } },
    });
    expect(counter).toMatchObject({ source: USAGE_SOURCE, yearMonth: currentYearMonth(), count: 1 });
  });

  it('allows the last call before the cap through and brings the counter to exactly the cap', async () => {
    await prisma.apiUsageCounter.create({
      data: { source: USAGE_SOURCE, yearMonth: currentYearMonth(), count: MONTHLY_FREE_TIER_CAP - 1 },
    });
    mockFetchJson(domainSearchSuccessBody);

    const result = await runHunterEnrichment(input);

    expect(result.ok).toBe(true);
    expect(await readUsageCount()).toBe(MONTHLY_FREE_TIER_CAP);
  });

  it('refuses the call and never touches fetch once the monthly cap has already been reserved', async () => {
    await prisma.apiUsageCounter.create({
      data: { source: USAGE_SOURCE, yearMonth: currentYearMonth(), count: MONTHLY_FREE_TIER_CAP },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runHunterEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: `source unavailable: Hunter.io free-tier quota (${MONTHLY_FREE_TIER_CAP}/month) already used this month`,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readUsageCount()).toBe(MONTHLY_FREE_TIER_CAP);
  });

  it('does not increment the counter past the cap even if called again after the cap is hit', async () => {
    await prisma.apiUsageCounter.create({
      data: { source: USAGE_SOURCE, yearMonth: currentYearMonth(), count: MONTHLY_FREE_TIER_CAP },
    });
    vi.stubGlobal('fetch', vi.fn());

    await runHunterEnrichment(input);
    await runHunterEnrichment(input);

    expect(await readUsageCount()).toBe(MONTHLY_FREE_TIER_CAP);
  });

  // The implementation reserves quota (increments the counter) *before*
  // making the Hunter API call. If the `fetch` call itself throws - a
  // network-level failure, meaning the request never reached Hunter's
  // servers - the reservation is rolled back, since Hunter could not
  // possibly have counted a request it never received against the real
  // account quota.
  it('rolls back the reserved quota unit when the Hunter API request itself throws (network failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runHunterEnrichment(input);

    expect(result.ok).toBe(false);
    expect(await readUsageCount()).toBe(0);
  });

  // A non-2xx response means Hunter's API did receive and process the
  // request - per Hunter's own billing, it was likely already counted
  // against the real account quota - so the reservation must NOT be rolled
  // back here, unlike the network-failure case above.
  it('still consumes the reserved quota unit when Hunter responds with a non-2xx status', async () => {
    mockFetchJson({}, { ok: false, status: 500 });

    const result = await runHunterEnrichment(input);

    expect(result.ok).toBe(false);
    expect(await readUsageCount()).toBe(1);
  });
});

describe('runHunterEnrichment response mapping', () => {
  beforeEach(() => {
    envMock.HUNTER_API_KEY = 'test-hunter-key';
  });

  it('uses the Domain Search endpoint and picks the highest-confidence email when no contact name is already known', async () => {
    const fetchMock = mockFetchJson({
      data: {
        emails: [
          { value: 'low@acme.com', confidence: 40 },
          { value: 'jane@acme.com', confidence: 90, first_name: 'Jane', last_name: 'Doe', position: 'CEO' },
        ],
      },
    });

    const result = await runHunterEnrichment(input);

    expect(result).toEqual({
      ok: true,
      contact: {
        contactName: 'Jane Doe',
        contactTitle: 'CEO',
        contactEmail: 'jane@acme.com',
        emailVerified: false,
        emailConfidence: 90,
        linkedinUrl: null,
      },
    });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toContain('/v2/domain-search');
  });

  it('uses the Email Finder endpoint when a contact name is already known', async () => {
    const fetchMock = mockFetchJson({
      data: {
        email: 'jane.doe@acme.com',
        score: 85,
        first_name: 'Jane',
        last_name: 'Doe',
        verification: { status: 'valid' },
      },
    });

    const result = await runHunterEnrichment({ ...input, contactName: 'Jane Doe' });

    expect(result).toEqual({
      ok: true,
      contact: {
        contactName: 'Jane Doe',
        contactTitle: null,
        contactEmail: 'jane.doe@acme.com',
        emailVerified: true,
        emailConfidence: 85,
        linkedinUrl: null,
      },
    });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toContain('/v2/email-finder');
  });

  it('only marks emailVerified true when Hunter\'s verification status is exactly "valid"', async () => {
    mockFetchJson({
      data: { emails: [{ value: 'jane@acme.com', confidence: 90, verification: { status: 'accept_all' } }] },
    });

    const result = await runHunterEnrichment(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.contact.emailVerified).toBe(false);
  });

  it('fails closed and reports unavailable when Hunter finds no email for the domain', async () => {
    mockFetchJson({ data: { emails: [] } });

    const result = await runHunterEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: Hunter.io found no emails for this domain' });
  });

  it('fails closed and reports unavailable when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runHunterEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Hunter.io request failed (ECONNREFUSED)',
    });
  });

  it('fails closed and reports unavailable when Hunter responds with a non-2xx status', async () => {
    mockFetchJson({}, { ok: false, status: 429 });

    const result = await runHunterEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: Hunter.io responded with 429' });
  });

  it('fails closed via zod rejection, not a crash, when the response shape is unrecognizable', async () => {
    mockFetchJson({ data: 'not-an-object' });

    const result = await runHunterEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Hunter.io response did not match the expected shape',
    });
  });
});
