import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` guarantees `envMock` is initialized before `vi.mock`'s factory
// (itself hoisted above this file's imports) ever runs.
const envMock = vi.hoisted(() => ({
  PEOPLE_DATA_LABS_API_KEY: 'test-pdl-key' as string | undefined,
  PEOPLE_DATA_LABS_MONTHLY_CAP: 100,
}));
vi.mock('@/common/config/env', () => ({ env: envMock }));

// In-memory fake, NOT a real database - unlike hunter.source.test.ts, this
// suite doesn't need Postgres's atomic `UPDATE ... WHERE count < cap` to
// prove race-safety (that's exercised there already for the identical
// pattern); it just needs `runPeopleDataLabsEnrichment` to not hit a real
// database at all. Handles both call shapes `reservePeopleDataLabsQuota`/
// `rollBackPeopleDataLabsQuota` in peopledatalabs.source.ts actually use:
// `where.count.lt` (reserve, conditional) and `where.count.gt` + `data.count.decrement`
// (rollback, unconditional once above 0).
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

import { runPeopleDataLabsEnrichment } from './peopledatalabs.source';

const input = { domain: 'acme.com', companyName: 'Acme Inc', contactName: null as string | null };

function mockFetchJson(body: unknown, options: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runPeopleDataLabsEnrichment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.PEOPLE_DATA_LABS_API_KEY = 'test-pdl-key';
    envMock.PEOPLE_DATA_LABS_MONTHLY_CAP = 100;
    usageState.count = 0;
  });

  it('reports source unavailable and never calls fetch when PEOPLE_DATA_LABS_API_KEY is not configured', async () => {
    envMock.PEOPLE_DATA_LABS_API_KEY = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: PEOPLE_DATA_LABS_API_KEY not configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('marks emailVerified true and scales likelihood to a 0-100 confidence when the match likelihood is at or above the high-confidence threshold (8)', async () => {
    mockFetchJson({
      status: 200,
      likelihood: 9,
      data: { full_name: 'Jane Doe', job_title: 'CEO', work_email: 'jane@acme.com', linkedin_url: 'https://linkedin.com/in/janedoe' },
    });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: true,
      contact: {
        contactName: 'Jane Doe',
        contactTitle: 'CEO',
        contactEmail: 'jane@acme.com',
        emailVerified: true,
        emailConfidence: 90,
        linkedinUrl: 'https://linkedin.com/in/janedoe',
      },
    });
  });

  it('marks emailVerified false when the match likelihood is below the high-confidence threshold (8)', async () => {
    mockFetchJson({
      status: 200,
      likelihood: 7,
      data: { full_name: 'Jane Doe', job_title: null, work_email: 'jane@acme.com', linkedin_url: null },
    });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.contact.emailVerified).toBe(false);
    expect(result.contact.emailConfidence).toBe(70);
  });

  it('rejects a match whose likelihood would scale to a confidence at or below the pattern-guess floor (15)', async () => {
    mockFetchJson({
      status: 200,
      likelihood: 1,
      data: { full_name: 'Jane Doe', work_email: 'jane@acme.com' },
    });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: PDL match likelihood (1) is too low to trust',
    });
  });

  it('accepts a match right at the minimum acceptable likelihood (2)', async () => {
    mockFetchJson({
      status: 200,
      likelihood: 2,
      data: { full_name: 'Jane Doe', work_email: 'jane@acme.com' },
    });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.contact.emailConfidence).toBe(20);
  });

  it('falls back to the input contactName when PDL returns no full_name of its own', async () => {
    mockFetchJson({ status: 200, likelihood: 9, data: { work_email: 'jane@acme.com' } });

    const result = await runPeopleDataLabsEnrichment({ ...input, contactName: 'Jane Doe' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.contact.contactName).toBe('Jane Doe');
  });

  it('fails closed and reports unavailable when PDL finds no work email for this contact', async () => {
    mockFetchJson({ status: 200, likelihood: 9, data: { full_name: 'Jane Doe', work_email: null } });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: PDL found no work email for this contact' });
  });

  it('fails closed and reports unavailable when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: PDL request failed (ECONNREFUSED)',
    });
  });

  it('fails closed and reports unavailable when PDL responds with a non-2xx status (e.g. 404 no match)', async () => {
    mockFetchJson({}, { ok: false, status: 404 });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: PDL responded with 404' });
  });

  it('fails closed via zod rejection, not a crash, when the response shape is unrecognizable', async () => {
    mockFetchJson({ status: 'not-a-number' });

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: PDL response did not match the expected shape',
    });
  });

  it('refuses to call PDL at all once the monthly cap is already used', async () => {
    envMock.PEOPLE_DATA_LABS_MONTHLY_CAP = 1;
    usageState.count = 1; // already at the cap
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runPeopleDataLabsEnrichment(input);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: People Data Labs monthly cap (1/month) already used this month',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rolls the reserved quota unit back when the network request throws, so a dead network never permanently burns quota', async () => {
    envMock.PEOPLE_DATA_LABS_MONTHLY_CAP = 5;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await runPeopleDataLabsEnrichment(input);

    expect(usageState.count).toBe(0);
  });
});
