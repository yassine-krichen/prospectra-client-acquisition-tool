import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` guarantees `envMock` is initialized before `vi.mock`'s factory
// (itself hoisted above this file's imports) ever runs.
const envMock = vi.hoisted(() => ({ GITHUB_TOKEN: undefined as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

import { runGitHubSource } from './github.source';

const query = { category: 'developer-tools', geography: 'ignored' };

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

const repoSearchBody = {
  items: [
    {
      id: 1,
      name: 'cool-lib',
      full_name: 'acme/cool-lib',
      description: 'A cool library',
      html_url: 'https://github.com/acme/cool-lib',
      homepage: 'https://acme.com',
    },
  ],
};

/**
 * Routes a mocked `fetch` by pathname, so each test only has to specify the
 * endpoints it cares about - every other GitHub endpoint this source hits
 * (readme, contents, workflows) degrades to its own documented "not found"
 * fallback rather than needing an explicit mock every time.
 */
function mockGitHubFetch(overrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/search/repositories')) {
      return jsonResponse(overrides.search ?? repoSearchBody);
    }
    if (url.endsWith('/readme')) {
      if (overrides.readme === 'not-found') return jsonResponse({}, { ok: false, status: 404 });
      return jsonResponse(overrides.readme ?? { content: '', encoding: 'base64' });
    }
    if (url.endsWith('/contents/.github/workflows')) {
      if (overrides.workflows === 'present') return jsonResponse([]);
      return jsonResponse({}, { ok: false, status: 404 });
    }
    if (url.endsWith('/contents/')) {
      return jsonResponse(overrides.rootContents ?? []);
    }
    throw new Error(`unmocked GitHub endpoint: ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runGitHubSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.GITHUB_TOKEN = undefined;
  });

  it('still runs (does not report unavailable) with no GITHUB_TOKEN configured, unlike the other Branch B sources', async () => {
    envMock.GITHUB_TOKEN = undefined;
    const fetchMock = mockGitHubFetch({ search: { items: [] } });

    const result = await runGitHubSource(query);

    expect(result).toEqual({ ok: true, prospects: [] });
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sends an Authorization header when GITHUB_TOKEN is configured', async () => {
    envMock.GITHUB_TOKEN = 'ghp_test';
    const fetchMock = mockGitHubFetch({ search: { items: [] } });

    await runGitHubSource(query);

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test');
  });

  it('flags a repo with a hiring keyword in its description as a medium hiring_post signal', async () => {
    mockGitHubFetch({
      search: {
        items: [
          {
            id: 1,
            name: 'cool-lib',
            full_name: 'acme/cool-lib',
            description: "We're hiring a backend engineer",
            html_url: 'https://github.com/acme/cool-lib',
            homepage: 'https://acme.com',
          },
        ],
      },
    });

    const result = await runGitHubSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toEqual([
      expect.objectContaining({
        companyName: 'cool-lib',
        domain: 'acme.com',
        source: 'github',
        signal: {
          type: 'hiring_post',
          description: 'Hiring/contributor-wanted keyword found in repo description',
          evidence: "We're hiring a backend engineer",
          strength: 'medium',
        },
      }),
    ]);
  });

  it('falls back to a technical_debt signal when no hiring keyword is found and the repo has no CI and no test directory', async () => {
    mockGitHubFetch();

    const result = await runGitHubSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects[0].signal).toEqual(
      expect.objectContaining({ type: 'technical_debt', strength: 'medium' })
    );
  });

  it('does not flag a repo that has both CI workflows and a test directory (no signal to report)', async () => {
    mockGitHubFetch({ workflows: 'present', rootContents: [{ name: 'tests', type: 'dir' }] });

    const result = await runGitHubSource(query);

    expect(result).toEqual({ ok: true, prospects: [] });
  });

  it('fails closed and reports unavailable when the network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runGitHubSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: GitHub request failed (ECONNREFUSED)',
    });
  });

  it('fails closed and reports unavailable when GitHub responds with a non-2xx status (e.g. rate limited)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 403 })));

    const result = await runGitHubSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: GitHub responded with 403',
    });
  });

  it('fails closed via zod rejection, not a crash, when the search response shape is unrecognizable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: 'not-an-array' })));

    const result = await runGitHubSource(query);

    expect(result).toEqual({
      ok: false,
      reason: 'source unavailable: GitHub response did not match the expected shape',
    });
  });
});
