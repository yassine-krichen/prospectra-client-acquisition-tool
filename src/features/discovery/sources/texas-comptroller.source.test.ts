import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ TEXAS_COMPTROLLER_API_KEY: 'test-key' as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

import { runTexasComptrollerSource } from './texas-comptroller.source';

const query = { category: 'plumber', geography: 'Austin, TX' };

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

function activeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Acme Plumbing LLC',
    mailingAddressCity: 'Austin',
    mailingAddressState: 'TX',
    sosRegistrationStatus: 'active',
    effectiveSosRegistrationDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('runTexasComptrollerSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.TEXAS_COMPTROLLER_API_KEY = 'test-key';
  });

  it('reports source unavailable and never calls fetch when TEXAS_COMPTROLLER_API_KEY is not configured', async () => {
    envMock.TEXAS_COMPTROLLER_API_KEY = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runTexasComptrollerSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: TEXAS_COMPTROLLER_API_KEY not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed and reports unavailable when the search call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runTexasComptrollerSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Texas Comptroller search request failed (ECONNREFUSED)',
    });
  });

  it('fails closed when the search call responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 500 })));

    const result = await runTexasComptrollerSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Texas Comptroller responded with 500',
    });
  });

  it('reports a distinct reason when the search term matches too many entities (413)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { success: false, error: 'Search will return 275 entries. Please refine search by Entity Name.' },
          { ok: false, status: 413 }
        )
      )
    );

    const result = await runTexasComptrollerSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Texas Comptroller search term matched too many entities - use a narrower category term',
    });
  });

  it('maps a two-call happy path: search returns ids, detail is fetched for each, mapped to prospects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          count: 2,
          data: [
            { taxpayerId: '1', name: 'Acme Plumbing LLC' },
            { taxpayerId: '2', name: 'Beta Plumbing LLC' },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse(activeDetail({ name: 'Acme Plumbing LLC' })))
      .mockResolvedValueOnce(jsonResponse(activeDetail({ name: 'Beta Plumbing LLC' })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTexasComptrollerSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.prospects).toHaveLength(2);
    expect(result.prospects[0]).toEqual(
      expect.objectContaining({
        companyName: 'Acme Plumbing LLC',
        source: 'texas_comptroller',
        domain: null,
        websiteUrl: null,
        signal: expect.objectContaining({ type: 'recently_registered', strength: 'strong' }),
      })
    );
  });

  it('skips a single detail fetch that fails, without failing the whole source', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          count: 2,
          data: [
            { taxpayerId: '1', name: 'Acme Plumbing LLC' },
            { taxpayerId: '2', name: 'Beta Plumbing LLC' },
          ],
        })
      )
      .mockRejectedValueOnce(new Error('detail lookup failed'))
      .mockResolvedValueOnce(jsonResponse(activeDetail({ name: 'Beta Plumbing LLC' })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTexasComptrollerSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects.map((prospect) => prospect.companyName)).toEqual(['Beta Plumbing LLC']);
  });

  it('filters out entries with a non-active sosRegistrationStatus', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, count: 1, data: [{ taxpayerId: '1', name: 'Inactive Co' }] })
      )
      .mockResolvedValueOnce(jsonResponse(activeDetail({ name: 'Inactive Co', sosRegistrationStatus: 'inactive' })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTexasComptrollerSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toEqual([]);
  });

  it('filters out entries missing sosRegistrationStatus, unlike Companies House which keeps missing-status entries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, count: 1, data: [{ taxpayerId: '1', name: 'No Status Co' }] })
      )
      .mockResolvedValueOnce(jsonResponse(activeDetail({ name: 'No Status Co', sosRegistrationStatus: undefined })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTexasComptrollerSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toEqual([]);
  });

  it('filters out results whose mailing address does not match the requested geography', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, count: 1, data: [{ taxpayerId: '1', name: 'Dallas Co' }] })
      )
      .mockResolvedValueOnce(
        jsonResponse(activeDetail({ name: 'Dallas Co', mailingAddressCity: 'Dallas', mailingAddressState: 'TX' }))
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTexasComptrollerSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toEqual([]);
  });

  it('caps detail lookups at MAX_DETAIL_LOOKUPS (20) even when the search returns more', async () => {
    const searchResults = Array.from({ length: 25 }, (_, index) => ({
      taxpayerId: String(index),
      name: `Company ${index}`,
    }));
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, count: 25, data: searchResults }));
    for (let i = 0; i < 20; i += 1) {
      fetchMock.mockResolvedValueOnce(jsonResponse(activeDetail({ name: `Company ${i}` })));
    }
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTexasComptrollerSource(query);

    expect(result.ok).toBe(true);
    // 1 search call + 20 detail calls, never 25.
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });
});
