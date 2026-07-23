import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` guarantees `envMock` is initialized before `vi.mock`'s factory
// (itself hoisted above this file's imports) ever runs.
const envMock = vi.hoisted(() => ({ CRUNCHBASE_API_KEY: 'test-key' as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

import { runCrunchbaseSource } from './crunchbase.source';

const query = { category: 'saas', geography: 'Austin, TX' };

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

const fundingRoundsBody = {
  entities: [
    {
      uuid: 'round-1',
      properties: {
        announced_on: '2026-06-01',
        money_raised: { value_usd: 5_000_000, currency: 'USD' },
        investment_type: 'seed',
        funded_organization_identifier: { value: 'Acme Inc', permalink: 'acme-inc' },
      },
    },
  ],
};

describe('runCrunchbaseSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.CRUNCHBASE_API_KEY = 'test-key';
  });

  it('reports source unavailable and never calls fetch when CRUNCHBASE_API_KEY is not configured', async () => {
    envMock.CRUNCHBASE_API_KEY = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runCrunchbaseSource(query);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: CRUNCHBASE_API_KEY not configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a funding round to a prospect with a strong funding_event signal, including the organization website', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fundingRoundsBody))
      .mockResolvedValueOnce(jsonResponse({ properties: { website: { value: 'https://acme.com' } } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCrunchbaseSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toEqual([
      expect.objectContaining({
        companyName: 'Acme Inc',
        domain: 'acme.com',
        websiteUrl: 'https://acme.com',
        industry: 'saas',
        source: 'crunchbase',
        signal: expect.objectContaining({
          type: 'funding_event',
          strength: 'strong',
          evidence: '$5,000,000 seed announced 2026-06-01',
        }),
      }),
    ]);
  });

  it('skips a funding round entity with no funded organization identifier, rather than crashing', async () => {
    mockOnlyFundingRounds({
      entities: [
        {
          uuid: 'round-2',
          properties: { announced_on: '2026-06-01', funded_organization_identifier: null },
        },
      ],
    });

    const result = await runCrunchbaseSource(query);

    expect(result).toEqual({ ok: true, prospects: [] });
  });

  it('fails closed and reports unavailable when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runCrunchbaseSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Crunchbase request failed (ECONNREFUSED)',
    });
  });

  it('fails closed and reports unavailable when Crunchbase responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 403 })));

    const result = await runCrunchbaseSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Crunchbase responded with 403',
    });
  });

  it('fails closed via zod rejection, not a crash, when the response shape is unrecognizable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ entities: 'not-an-array' })));

    const result = await runCrunchbaseSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Crunchbase response did not match the expected shape',
    });
  });

  function mockOnlyFundingRounds(body: unknown): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
  }
});
