import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ GOOGLE_PLACES_API_KEY: 'test-places-key' as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

import { runGooglePlacesSource } from './google-places.source';

const query = { category: 'cafe', geography: 'Austin, TX' };

const textSearchBody = {
  status: 'OK',
  results: [{ place_id: 'place-1', name: 'Acme Cafe', business_status: 'OPERATIONAL', user_ratings_total: 50 }],
};

function mockFetchSequence(...bodies: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockImplementationOnce(async () => ({ ok: true, json: () => Promise.resolve(body) }));
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runGooglePlacesSource contact fields', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.GOOGLE_PLACES_API_KEY = 'test-places-key';
  });

  it('requests phone and address alongside website in the same Place Details call (no separate lookup)', async () => {
    const fetchMock = mockFetchSequence(textSearchBody, {
      status: 'OK',
      result: { website: 'https://acme.example.com', formatted_phone_number: '(512) 555-0100', formatted_address: '1 Main St, Austin, TX' },
    });

    await runGooglePlacesSource(query);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const detailsUrl = new URL(fetchMock.mock.calls[1][0] as string | URL);
    expect(detailsUrl.searchParams.get('fields')).toBe('website,formatted_phone_number,formatted_address');
  });

  it('carries phone and address through onto the discovered prospect when Google Places returns them', async () => {
    mockFetchSequence(textSearchBody, {
      status: 'OK',
      result: { website: 'https://acme.example.com', formatted_phone_number: '(512) 555-0100', formatted_address: '1 Main St, Austin, TX' },
    });

    const result = await runGooglePlacesSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects[0]).toMatchObject({ phone: '(512) 555-0100', address: '1 Main St, Austin, TX' });
  });

  it('falls back to null phone/address (not a thrown error) when Place Details has no result at all - e.g. a no-website listing', async () => {
    mockFetchSequence(textSearchBody, { status: 'OK' });

    const result = await runGooglePlacesSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects[0]).toMatchObject({ phone: null, address: null, domain: null, websiteUrl: null });
  });

  it('falls back to null phone/address when the Place Details request itself fails, without failing the whole source', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({ ok: true, json: () => Promise.resolve(textSearchBody) }))
      .mockImplementationOnce(async () => ({ ok: false, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runGooglePlacesSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects[0]).toMatchObject({ phone: null, address: null });
  });
});
