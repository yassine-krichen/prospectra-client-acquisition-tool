import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` guarantees `envMock` is initialized before `vi.mock`'s factory
// (itself hoisted above this file's imports) ever runs.
const envMock = vi.hoisted(() => ({ GITHUB_TOKEN: undefined as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

import { lookupGitHubEvidence } from './github.source';
import type { DiscoveredProspect } from '@/features/discovery/discovery.types';

function buildProspect(overrides: Partial<DiscoveredProspect> = {}): DiscoveredProspect {
  return {
    companyName: 'Acme Co',
    domain: 'acme.com',
    websiteUrl: 'https://acme.com',
    industry: 'saas',
    location: { city: null, country: null, lat: null, lng: null },
    companySize: 'unknown',
    source: 'google_places',
    sourceUrl: 'https://example.com/source',
    discoveredAt: new Date('2026-01-01'),
    signal: { type: 'outdated_site', description: 'stale', evidence: null, strength: 'weak' },
    phone: null,
    address: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

const acmeOrgAccount = { login: 'acme', blog: 'https://acme.com' };
const acmeRepo = {
  name: 'cool-lib',
  full_name: 'acme/cool-lib',
  description: 'A cool library',
  html_url: 'https://github.com/acme/cool-lib',
  homepage: 'https://acme.com',
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

    if (url.includes('/orgs/')) {
      if (url.includes('/repos?')) return jsonResponse(overrides.orgRepos ?? [acmeRepo]);
      if (overrides.org === 'not-found') return jsonResponse({}, { ok: false, status: 404 });
      return jsonResponse(overrides.org ?? acmeOrgAccount);
    }
    if (url.includes('/users/')) {
      if (url.includes('/repos?')) return jsonResponse(overrides.userRepos ?? []);
      if (overrides.user === 'not-found' || overrides.user === undefined) return jsonResponse({}, { ok: false, status: 404 });
      return jsonResponse(overrides.user);
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

describe('lookupGitHubEvidence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    envMock.GITHUB_TOKEN = undefined;
  });

  it('returns no match without calling GitHub when the prospect has no domain', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await lookupGitHubEvidence(buildProspect({ domain: null }));

    expect(result).toEqual({ ok: true, lookup: { matched: false, signal: null } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tries the org lookup first, using the domain root as the slug', async () => {
    const fetchMock = mockGitHubFetch();

    await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(fetchMock.mock.calls[0][0].toString()).toContain('/orgs/acme');
  });

  it('falls back to the user lookup when no org matches that slug', async () => {
    const fetchMock = mockGitHubFetch({ org: 'not-found', user: { login: 'acme', blog: 'https://acme.com' } });

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(fetchMock.mock.calls.some((call) => call[0].toString().includes('/users/acme'))).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.matched).toBe(true);
  });

  it('does not treat an account as a match when its declared website does not resolve to the prospect domain', async () => {
    mockGitHubFetch({ org: { login: 'acme', blog: 'https://unrelated-company.example' } });

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(result).toEqual({ ok: true, lookup: { matched: false, signal: null } });
  });

  it('does not treat an account with no declared website as a match', async () => {
    mockGitHubFetch({ org: { login: 'acme', blog: null } });

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(result).toEqual({ ok: true, lookup: { matched: false, signal: null } });
  });

  it('returns no match when neither the org nor user lookup finds an account', async () => {
    mockGitHubFetch({ org: 'not-found' });

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(result).toEqual({ ok: true, lookup: { matched: false, signal: null } });
  });

  it('flags a matched account repo with a hiring keyword in its description as a medium hiring_post signal', async () => {
    mockGitHubFetch({
      orgRepos: [{ ...acmeRepo, description: "We're hiring a backend engineer" }],
    });

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.matched).toBe(true);
    expect(result.lookup.signal).toEqual({
      type: 'hiring_post',
      description: 'Hiring/contributor-wanted keyword found in repo description',
      evidence: "We're hiring a backend engineer",
      strength: 'medium',
    });
  });

  it('falls back to a technical_debt signal when no hiring keyword is found and the repo has no CI and no test directory', async () => {
    mockGitHubFetch();

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.signal).toEqual(expect.objectContaining({ type: 'technical_debt', strength: 'medium' }));
  });

  it('matches but reports no signal when the account has both CI and tests on every checked repo', async () => {
    mockGitHubFetch({ workflows: 'present', rootContents: [{ name: 'tests', type: 'dir' }] });

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(result).toEqual({ ok: true, lookup: { matched: true, signal: null } });
  });

  it('caps the number of repos checked per account rather than checking every repo', async () => {
    const fetchMock = mockGitHubFetch();

    await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    const reposCall = fetchMock.mock.calls.find((call) => call[0].toString().includes('/orgs/acme/repos'));
    expect(reposCall).toBeDefined();
    expect(reposCall?.[0].toString()).toContain('per_page=3');
  });

  it('sends an Authorization header when GITHUB_TOKEN is configured', async () => {
    envMock.GITHUB_TOKEN = 'ghp_test';
    const fetchMock = mockGitHubFetch();

    await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test');
  });

  it('still runs (does not fail closed) with no GITHUB_TOKEN configured', async () => {
    envMock.GITHUB_TOKEN = undefined;
    const fetchMock = mockGitHubFetch({ org: 'not-found' });

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(result.ok).toBe(true);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('reports no match, not a crash, when the org lookup request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await lookupGitHubEvidence(buildProspect({ domain: 'acme.com' }));

    expect(result).toEqual({ ok: true, lookup: { matched: false, signal: null } });
  });
});
