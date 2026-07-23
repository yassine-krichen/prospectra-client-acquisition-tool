import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` guarantees `envMock` is initialized before `vi.mock`'s factory
// (itself hoisted above this file's imports) ever runs.
const envMock = vi.hoisted(() => ({ PRODUCT_HUNT_API_TOKEN: 'test-token' as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

import { runProductHuntSource } from './product-hunt.source';

const query = { category: 'saas', geography: 'Austin, TX' };

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

describe('runProductHuntSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.PRODUCT_HUNT_API_TOKEN = 'test-token';
  });

  it('reports source unavailable and never calls fetch when PRODUCT_HUNT_API_TOKEN is not configured', async () => {
    envMock.PRODUCT_HUNT_API_TOKEN = undefined;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runProductHuntSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: PRODUCT_HUNT_API_TOKEN not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a valid GraphQL response to a prospect with a strong new_launch signal', async () => {
    mockFetchJson({
      data: {
        posts: {
          edges: [
            {
              node: {
                id: '1',
                name: 'Acme Launcher',
                tagline: 'Ship faster',
                url: 'https://www.producthunt.com/posts/acme-launcher',
                website: 'https://acme.com',
              },
            },
          ],
        },
      },
    });

    const result = await runProductHuntSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toEqual([
      expect.objectContaining({
        companyName: 'Acme Launcher',
        domain: 'acme.com',
        websiteUrl: 'https://acme.com',
        industry: 'saas',
        source: 'product_hunt',
        sourceUrl: 'https://www.producthunt.com/posts/acme-launcher',
        signal: {
          type: 'new_launch',
          description: 'Recently launched on Product Hunt',
          evidence: 'Ship faster',
          strength: 'strong',
        },
      }),
    ]);
  });

  it('extracts a null domain when the launch has no website', async () => {
    mockFetchJson({
      data: {
        posts: {
          edges: [
            {
              node: {
                id: '1',
                name: 'No Website Co',
                tagline: null,
                url: 'https://www.producthunt.com/posts/no-website-co',
                website: null,
              },
            },
          ],
        },
      },
    });

    const result = await runProductHuntSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects[0].domain).toBeNull();
    expect(result.prospects[0].websiteUrl).toBeNull();
  });

  it('fails closed and reports unavailable when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runProductHuntSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Product Hunt request failed (ECONNREFUSED)',
    });
  });

  it('fails closed and reports unavailable when Product Hunt responds with a non-2xx status', async () => {
    mockFetchJson({}, { ok: false, status: 401 });

    const result = await runProductHuntSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Product Hunt responded with 401',
    });
  });

  it('fails closed via zod rejection, not a crash, when `data` is present but not the expected object shape', async () => {
    mockFetchJson({ data: 'not-an-object' });

    const result = await runProductHuntSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Product Hunt response did not match the expected shape',
    });
  });

  it('fails closed and reports unavailable when the GraphQL response has no data (e.g. a GraphQL error)', async () => {
    mockFetchJson({ errors: [{ message: 'topic not found' }] });

    const result = await runProductHuntSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: Product Hunt returned no data (topic not found)',
    });
  });
});
