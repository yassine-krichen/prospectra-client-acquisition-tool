import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ COMPANIES_HOUSE_API_KEY: 'test-key' as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

import { runCompaniesHouseSource } from './companies-house.source';

const query = { category: 'plumber', geography: 'London' };

function mockFetchJson(body: unknown, options: { ok?: boolean; status?: number } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: options.ok ?? true,
      status: options.status ?? 200,
      json: () => Promise.resolve(body),
    })
  );
}

describe('runCompaniesHouseSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.COMPANIES_HOUSE_API_KEY = 'test-key';
  });

  it('reports source unavailable and never calls fetch when COMPANIES_HOUSE_API_KEY is not configured', async () => {
    envMock.COMPANIES_HOUSE_API_KEY = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runCompaniesHouseSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: COMPANIES_HOUSE_API_KEY not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Regression coverage: the schema used to require `company_name`, a field
  // the real search API never actually returns (it uses `title` - confirmed
  // live 2026-08-30 against a real API response, included below verbatim
  // alongside the extra fields Zod silently ignores) - every real search
  // failed validation and the source reported itself unavailable on every
  // call, even with a valid API key.
  it('maps a response shaped like a real Companies House search result (extra unmapped fields included)', async () => {
    mockFetchJson({
      items: [
        {
          kind: 'searchresults#company',
          description_identifier: ['incorporated-on'],
          company_status: 'active',
          date_of_creation: '2019-12-09',
          company_type: 'ltd',
          company_number: '12353272',
          address: {
            address_line_1: 'Cobham Park Road',
            country: 'United Kingdom',
            locality: 'London',
            postal_code: 'KT11 3NE',
            premises: 'The Long Barn',
            region: 'Surrey',
          },
          title: 'ACCRUE WORKPLACES LTD',
          // Includes "London" so this fixture also satisfies the shared
          // module-level `query`'s geography filter (`matchesGeography`) -
          // not the focus of this test, which is the field-shape mapping.
          address_snippet: 'The Long Barn, Cobham Park Road, London, Surrey, United Kingdom, KT11 3NE',
          description: '12353272 - Incorporated on 9 December 2019',
          links: { self: '/company/12353272' },
          snippet: 'CAFE ACCRUE LTD',
          matches: { snippet: [] },
        },
      ],
    });

    const result = await runCompaniesHouseSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects[0]).toEqual(expect.objectContaining({ companyName: 'ACCRUE WORKPLACES LTD' }));
  });

  it('fails closed via zod rejection, not a crash, when the response does not match the expected shape', async () => {
    mockFetchJson({ items: 'not-an-array' });

    const result = await runCompaniesHouseSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Companies House response did not match the expected shape',
    });
  });

  it('maps a valid response to a prospect with a registry signal', async () => {
    mockFetchJson({
      items: [
        {
          title: 'Acme Plumbing Ltd',
          company_number: '12345678',
          address_snippet: '1 High Street, London',
          date_of_creation: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          company_status: 'active',
        },
      ],
    });

    const result = await runCompaniesHouseSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toEqual([
      expect.objectContaining({
        companyName: 'Acme Plumbing Ltd',
        domain: null,
        websiteUrl: null,
        industry: 'other',
        source: 'companies_house',
        sourceUrl: 'https://find-and-update.company-information.service.gov.uk/company/12345678',
        address: '1 High Street, London',
        signal: expect.objectContaining({ type: 'recently_registered', strength: 'strong' }),
      }),
    ]);
  });

  it('filters out results whose address does not match the requested geography', async () => {
    mockFetchJson({
      items: [
        { title: 'Manchester Co', company_number: '1', address_snippet: '1 Deansgate, Manchester' },
        { title: 'London Co', company_number: '2', address_snippet: '1 High Street, London' },
      ],
    });

    const result = await runCompaniesHouseSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects.map((prospect) => prospect.companyName)).toEqual(['London Co']);
  });

  it('keeps a result with no address_snippet, since geography cannot be checked either way', async () => {
    mockFetchJson({
      items: [{ title: 'No Address Co', company_number: '3' }],
    });

    const result = await runCompaniesHouseSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects.map((prospect) => prospect.companyName)).toEqual(['No Address Co']);
  });

  it('filters out companies with a non-active company_status', async () => {
    mockFetchJson({
      items: [
        { title: 'Dissolved Co', company_number: '4', company_status: 'dissolved' },
        { title: 'Active Co', company_number: '5', company_status: 'active' },
      ],
    });

    const result = await runCompaniesHouseSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects.map((prospect) => prospect.companyName)).toEqual(['Active Co']);
  });

  it('keeps a company with no company_status, since active-ness cannot be confirmed either way', async () => {
    mockFetchJson({
      items: [{ title: 'Unknown Status Co', company_number: '6' }],
    });

    const result = await runCompaniesHouseSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects.map((prospect) => prospect.companyName)).toEqual(['Unknown Status Co']);
  });

  it('fails closed and reports unavailable when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runCompaniesHouseSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Companies House request failed (ECONNREFUSED)',
    });
  });

  it('fails closed and reports unavailable when Companies House responds with a non-2xx status', async () => {
    mockFetchJson({}, { ok: false, status: 401 });

    const result = await runCompaniesHouseSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Companies House responded with 401',
    });
  });
});
