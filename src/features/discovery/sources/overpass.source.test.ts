import { afterEach, describe, expect, it, vi } from 'vitest';

import { runOverpassSource } from './overpass.source';

const query = { category: 'plumber', geography: 'Austin, TX' };

const GEOCODE_SUCCESS = [{ osm_type: 'relation', osm_id: 123456 }];

/**
 * Mocks the two-stage HTTP flow every `runOverpassSource` call makes: a
 * Nominatim geocode request (URL contains "nominatim"), then an Overpass
 * query (URL is the interpreter endpoint) - branching on the request URL so
 * each test only needs to describe what each endpoint returns.
 */
function mockFetch(options: {
  geocodeBody?: unknown;
  geocodeOk?: boolean;
  overpassBody?: unknown;
  overpassOk?: boolean;
  overpassStatus?: number;
  overpassError?: Error;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation((input: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();

    if (url.includes('nominatim.openstreetmap.org')) {
      return Promise.resolve({
        ok: options.geocodeOk ?? true,
        json: () => Promise.resolve(options.geocodeBody ?? GEOCODE_SUCCESS),
      });
    }

    if (options.overpassError) return Promise.reject(options.overpassError);

    return Promise.resolve({
      ok: options.overpassOk ?? true,
      status: options.overpassStatus ?? 200,
      json: () => Promise.resolve(options.overpassBody ?? { elements: [] }),
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runOverpassSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports source unavailable and never calls Overpass when geocoding finds nothing', async () => {
    const fetchMock = mockFetch({ geocodeBody: [] });

    const result = await runOverpassSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: could not resolve geography to a location',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a valid Overpass response to a prospect with phone, address, and website extracted from tags', async () => {
    mockFetch({
      overpassBody: {
        elements: [
          {
            type: 'node',
            id: 111,
            lat: 30.27,
            lon: -97.74,
            tags: {
              name: 'Clarke Kent Plumbing',
              website: 'https://clarkekentplumbing.com',
              phone: '(512) 766-0970',
              'addr:housenumber': '1408',
              'addr:street': 'W Ben White Blvd',
              'addr:city': 'Austin',
              'addr:postcode': '78704',
            },
          },
        ],
      },
    });

    const result = await runOverpassSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toEqual([
      expect.objectContaining({
        companyName: 'Clarke Kent Plumbing',
        domain: 'clarkekentplumbing.com',
        websiteUrl: 'https://clarkekentplumbing.com',
        phone: '(512) 766-0970',
        address: '1408 W Ben White Blvd, Austin 78704',
        source: 'manual',
        sourceUrl: 'https://www.openstreetmap.org/node/111',
        location: expect.objectContaining({ lat: 30.27, lng: -97.74 }),
      }),
    ]);
  });

  it('reads lat/lng from `center` for a way element', async () => {
    mockFetch({
      overpassBody: {
        elements: [{ type: 'way', id: 222, center: { lat: 30.3, lon: -97.7 }, tags: { name: 'Some Shop' } }],
      },
    });

    const result = await runOverpassSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects[0].location).toEqual(expect.objectContaining({ lat: 30.3, lng: -97.7 }));
  });

  it('returns an empty prospect list when Overpass returns zero elements', async () => {
    mockFetch({ overpassBody: { elements: [] } });

    const result = await runOverpassSource(query);

    expect(result).toEqual({ ok: true, prospects: [] });
  });

  it('skips an element that has tags but no `name`', async () => {
    mockFetch({
      overpassBody: {
        elements: [{ type: 'node', id: 333, lat: 30.1, lon: -97.1, tags: { craft: 'plumber' } }],
      },
    });

    const result = await runOverpassSource(query);

    expect(result).toEqual({ ok: true, prospects: [] });
  });

  it('extracts null phone/address/website when none of the relevant tags are present', async () => {
    mockFetch({
      overpassBody: {
        elements: [{ type: 'node', id: 444, lat: 30.1, lon: -97.1, tags: { name: 'Nameless Plumbing' } }],
      },
    });

    const result = await runOverpassSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects[0]).toEqual(
      expect.objectContaining({ phone: null, address: null, websiteUrl: null, domain: null })
    );
    expect(result.prospects[0].signal).toEqual({
      type: 'no_website',
      description: 'No website tagged on OpenStreetMap',
      evidence: null,
      strength: 'strong',
    });
  });

  it('fails closed and reports unavailable when the Overpass request throws', async () => {
    mockFetch({ overpassError: new Error('ECONNREFUSED') });

    const result = await runOverpassSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Overpass request failed (ECONNREFUSED)',
    });
  });

  it('fails closed and reports unavailable when Overpass responds with a non-2xx status', async () => {
    mockFetch({ overpassOk: false, overpassStatus: 504 });

    const result = await runOverpassSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Overpass responded with 504',
    });
  });
});
