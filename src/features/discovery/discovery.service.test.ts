import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveredProspect, DiscoveryQuery } from '@/features/discovery/discovery.types';
import type { StaleStackResult } from '@/features/discovery/sources/builtwith.source';
import type { Signal } from '@/features/prospects/prospect.types';

// This is an orchestration test: the sources and the DB are already/will be
// tested elsewhere, so both are mocked here and only `discovery.service.ts`'s
// own orchestration logic (dedupe, enrichment gating, priority scoring,
// persistence branching, source-unavailable reporting) is under test.
const { prospectMock, findFirstMock, createMock, updateMock, discoveryRunCreateMock, discoveryRunFindManyMock } =
  vi.hoisted(() => {
    const findFirst = vi.fn();
    const create = vi.fn();
    const update = vi.fn();
    const discoveryRunCreate = vi.fn();
    const discoveryRunFindMany = vi.fn();
    return {
      prospectMock: { findFirst, create, update },
      findFirstMock: findFirst,
      createMock: create,
      updateMock: update,
      discoveryRunCreateMock: discoveryRunCreate,
      discoveryRunFindManyMock: discoveryRunFindMany,
    };
  });

vi.mock('@/common/db/client', () => ({
  prisma: { prospect: prospectMock, discoveryRun: { create: discoveryRunCreateMock, findMany: discoveryRunFindManyMock } },
}));

const envMock: { BUILTWITH_API_KEY: string | undefined } = { BUILTWITH_API_KEY: undefined };
vi.mock('@/common/config/env', () => ({ env: envMock }));

const runGooglePlacesSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/google-places.source', () => ({
  runGooglePlacesSource: runGooglePlacesSourceMock,
}));

const runYellowPagesSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/yellowpages.source', () => ({
  runYellowPagesSource: runYellowPagesSourceMock,
}));

const lookupStaleStackMock = vi.fn();
vi.mock('@/features/discovery/sources/builtwith.source', () => ({
  lookupStaleStack: lookupStaleStackMock,
}));

const runProductHuntSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/product-hunt.source', () => ({
  runProductHuntSource: runProductHuntSourceMock,
}));

const runCrunchbaseSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/crunchbase.source', () => ({
  runCrunchbaseSource: runCrunchbaseSourceMock,
}));

const runGitHubSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/github.source', () => ({
  runGitHubSource: runGitHubSourceMock,
}));

const runIndieHackersSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/indiehackers.source', () => ({
  runIndieHackersSource: runIndieHackersSourceMock,
}));

const { runDiscovery, listRecentDiscoveryRuns } = await import('./discovery.service');

function buildSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: 'outdated_site',
    description: 'stale',
    evidence: null,
    strength: 'medium',
    ...overrides,
  };
}

function buildProspect(overrides: Partial<DiscoveredProspect> = {}): DiscoveredProspect {
  return {
    companyName: 'Acme Co',
    domain: 'acme.com',
    websiteUrl: 'https://acme.com',
    industry: 'local_service',
    location: { city: 'Austin', country: null, lat: null, lng: null },
    companySize: 'unknown',
    source: 'google_places',
    sourceUrl: 'https://example.com/source',
    discoveredAt: new Date('2026-01-01'),
    signal: buildSignal(),
    ...overrides,
  };
}

const query: DiscoveryQuery = { category: 'plumber', geography: 'Austin, TX' };

beforeEach(() => {
  vi.clearAllMocks();
  envMock.BUILTWITH_API_KEY = undefined;
  runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runYellowPagesSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runProductHuntSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runCrunchbaseSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runGitHubSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runIndieHackersSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  findFirstMock.mockResolvedValue(null);
  createMock.mockResolvedValue(undefined);
  updateMock.mockResolvedValue(undefined);
  discoveryRunCreateMock.mockResolvedValue(undefined);
});

describe('runDiscovery', () => {
  it('inserts a newly discovered prospect that has no existing record', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });

    const summary = await runDiscovery(query);

    expect(summary.inserted).toBe(1);
    expect(summary.updated).toBe(0);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('updates instead of inserting when a prospect with the same domain already exists', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });
    findFirstMock.mockResolvedValue({ id: 'existing-id' });

    const summary = await runDiscovery(query);

    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'existing-id' } })
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('recomputes suggestedServices/projectFit/estimatedBudget on the update path too, not just on insert', async () => {
    // no_https signal (default buildSignal type below) drives a landing_page
    // primary via the matching engine - asserting the actual values here
    // (not just "some object") is what proves this is genuinely recomputed
    // on re-discovery, not a stale carry-over from the prior scrape.
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ signal: buildSignal({ type: 'no_https' }) })],
    });
    findFirstMock.mockResolvedValue({ id: 'existing-id' });

    await runDiscovery(query);

    const call = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.projectFit).toBe('landing_page');
    expect(call.data.estimatedBudget).not.toBeUndefined();
    expect(Array.isArray(call.data.suggestedServices)).toBe(true);
    expect((call.data.suggestedServices as Array<{ role: string }>).some((s) => s.role === 'primary')).toBe(true);
  });

  it('dedupes two sources reporting the same normalized domain into a single persisted prospect', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'Example.com', companyName: 'From Google' })],
    });
    runYellowPagesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'www.example.com', companyName: 'From YellowPages' })],
    });

    const summary = await runDiscovery(query);

    expect(summary.totalFound).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe two prospects from different domains', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'acme.com' }), buildProspect({ domain: 'other.com' })],
    });

    const summary = await runDiscovery(query);

    expect(summary.totalFound).toBe(2);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('reports a source with a missing API key as skipped-with-reason instead of aborting the run', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: false,
      reason: 'source unavailable: GOOGLE_PLACES_API_KEY not configured',
    });
    runYellowPagesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });

    const summary = await runDiscovery(query);

    const googlePlacesSummary = summary.sources.find((s) => s.source === 'google_places');
    expect(googlePlacesSummary).toEqual({
      source: 'google_places',
      ran: false,
      reason: 'source unavailable: GOOGLE_PLACES_API_KEY not configured',
      count: 0,
    });
    // The run still completes and persists the source that did succeed.
    expect(summary.inserted).toBe(1);
  });

  it('reports builtwith as unavailable with a clear reason when BUILTWITH_API_KEY is not configured', async () => {
    envMock.BUILTWITH_API_KEY = undefined;
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });

    const summary = await runDiscovery(query);

    const builtwithSummary = summary.sources.find((s) => s.source === 'builtwith');
    expect(builtwithSummary).toEqual({
      source: 'builtwith',
      ran: false,
      reason: 'source unavailable: BUILTWITH_API_KEY not configured',
      count: 0,
    });
    expect(lookupStaleStackMock).not.toHaveBeenCalled();
  });

  it('upgrades a prospect signal with a stronger BuiltWith stale-stack signal when BuiltWith is configured', async () => {
    envMock.BUILTWITH_API_KEY = 'test-key';
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ signal: buildSignal({ strength: 'weak' }) })],
    });
    const staleStackSignal = buildSignal({ type: 'old_stack', strength: 'strong', description: 'jQuery 1.x' });
    lookupStaleStackMock.mockResolvedValue({
      ok: true,
      lookup: { domain: 'acme.com', technologies: ['jQuery 1.9.1'], signal: staleStackSignal },
    } satisfies StaleStackResult);

    const summary = await runDiscovery(query);

    const builtwithSummary = summary.sources.find((s) => s.source === 'builtwith');
    expect(builtwithSummary?.ran).toBe(true);
    expect(builtwithSummary?.count).toBe(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signal: staleStackSignal, priorityScore: 3 }) })
    );
  });

  it('does not downgrade a prospect signal when BuiltWith reports a weaker signal than the source already found', async () => {
    envMock.BUILTWITH_API_KEY = 'test-key';
    const strongExistingSignal = buildSignal({ strength: 'strong', description: 'no https' });
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ signal: strongExistingSignal })],
    });
    lookupStaleStackMock.mockResolvedValue({
      ok: true,
      lookup: {
        domain: 'acme.com',
        technologies: ['jQuery'],
        signal: buildSignal({ type: 'old_stack', strength: 'weak' }),
      },
    } satisfies StaleStackResult);

    const summary = await runDiscovery(query);

    const builtwithSummary = summary.sources.find((s) => s.source === 'builtwith');
    expect(builtwithSummary?.count).toBe(0);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signal: strongExistingSignal, priorityScore: 3 }) })
    );
  });

  it.each([
    ['strong', 3],
    ['medium', 2],
    ['weak', 1],
  ] as const)('computes a priorityScore of %s for a %s signal strength', async (strength, expectedScore) => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ signal: buildSignal({ strength }) })],
    });

    await runDiscovery(query);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priorityScore: expectedScore }) })
    );
  });

  it('rejects an invalid query missing required fields', async () => {
    await expect(runDiscovery({ category: '' })).rejects.toThrow();
  });

  it('persists a DiscoveryRun row recording the query, branch, and outcome counts', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });

    const summary = await runDiscovery(query, 'a');

    expect(discoveryRunCreateMock).toHaveBeenCalledWith({
      data: {
        category: 'plumber',
        geography: 'Austin, TX',
        branch: 'a',
        totalFound: summary.totalFound,
        inserted: summary.inserted,
        updated: summary.updated,
        skippedDoNotContact: summary.skippedDoNotContact,
        sources: summary.sources,
      },
    });
  });

  it('does not fail the discovery run when persisting the DiscoveryRun row fails', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });
    discoveryRunCreateMock.mockRejectedValue(new Error('db unavailable'));

    const summary = await runDiscovery(query);

    expect(summary.inserted).toBe(1);
  });
});

describe('listRecentDiscoveryRuns', () => {
  it('returns the discoveryRun.findMany result ordered newest first, defaulting to a limit of 20', async () => {
    discoveryRunFindManyMock.mockResolvedValue([{ id: 'run-1' }]);

    const result = await listRecentDiscoveryRuns();

    expect(discoveryRunFindManyMock).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' }, take: 20 });
    expect(result).toEqual([{ id: 'run-1' }]);
  });

  it('passes a custom limit through to discoveryRun.findMany', async () => {
    discoveryRunFindManyMock.mockResolvedValue([]);

    await listRecentDiscoveryRuns(5);

    expect(discoveryRunFindManyMock).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' }, take: 5 });
  });
});

describe('runDiscovery branch selection', () => {
  it('defaults to branch "a" (local/SMB only) when no branch argument is given, preserving Phase 1 behavior', async () => {
    await runDiscovery(query);

    expect(runGooglePlacesSourceMock).toHaveBeenCalledTimes(1);
    expect(runYellowPagesSourceMock).toHaveBeenCalledTimes(1);
    expect(runProductHuntSourceMock).not.toHaveBeenCalled();
    expect(runCrunchbaseSourceMock).not.toHaveBeenCalled();
    expect(runGitHubSourceMock).not.toHaveBeenCalled();
    expect(runIndieHackersSourceMock).not.toHaveBeenCalled();
  });

  it('runs only Branch A sources when branch is explicitly "a"', async () => {
    const summary = await runDiscovery(query, 'a');

    expect(summary.sources.map((s) => s.source).sort()).toEqual(['builtwith', 'google_places', 'yellowpages']);
    expect(runProductHuntSourceMock).not.toHaveBeenCalled();
  });

  it('runs only Branch B sources (product_hunt, crunchbase, github, indiehackers) when branch is "b"', async () => {
    const summary = await runDiscovery(query, 'b');

    expect(runGooglePlacesSourceMock).not.toHaveBeenCalled();
    expect(runYellowPagesSourceMock).not.toHaveBeenCalled();
    expect(runProductHuntSourceMock).toHaveBeenCalledTimes(1);
    expect(runCrunchbaseSourceMock).toHaveBeenCalledTimes(1);
    expect(runGitHubSourceMock).toHaveBeenCalledTimes(1);
    expect(runIndieHackersSourceMock).toHaveBeenCalledTimes(1);
    expect(summary.sources.map((s) => s.source).sort()).toEqual([
      'builtwith',
      'crunchbase',
      'github',
      'indiehackers',
      'product_hunt',
    ]);
  });

  it('records the requested branch on the returned summary', async () => {
    const summary = await runDiscovery(query, 'b');

    expect(summary.branch).toBe('b');
  });

  it('runs every source exactly once (not twice) when branch is "both"', async () => {
    await runDiscovery(query, 'both');

    expect(runGooglePlacesSourceMock).toHaveBeenCalledTimes(1);
    expect(runYellowPagesSourceMock).toHaveBeenCalledTimes(1);
    expect(runProductHuntSourceMock).toHaveBeenCalledTimes(1);
    expect(runCrunchbaseSourceMock).toHaveBeenCalledTimes(1);
    expect(runGitHubSourceMock).toHaveBeenCalledTimes(1);
    expect(runIndieHackersSourceMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes a Branch A and a Branch B source reporting the same normalized domain into a single persisted prospect when branch is "both"', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'acme.com', companyName: 'From Google', source: 'google_places' })],
    });
    runProductHuntSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'acme.com', companyName: 'From Product Hunt', source: 'product_hunt' })],
    });

    const summary = await runDiscovery(query, 'both');

    expect(summary.totalFound).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe a Branch A and a Branch B prospect from genuinely different domains when branch is "both"', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'acme.com', source: 'google_places' })],
    });
    runProductHuntSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'other.com', source: 'product_hunt' })],
    });

    const summary = await runDiscovery(query, 'both');

    expect(summary.totalFound).toBe(2);
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});

describe('runDiscovery enabledSources filtering', () => {
  it('runs every source for the branch, unfiltered, when enabledSources is omitted (backward compat)', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });

    const summary = await runDiscovery(query, 'a');

    expect(runGooglePlacesSourceMock).toHaveBeenCalledTimes(1);
    expect(runYellowPagesSourceMock).toHaveBeenCalledTimes(1);
    expect(summary.sources.every((s) => s.reason !== 'disabled for this run')).toBe(true);
  });

  it('skips a source not listed in enabledSources instead of calling it', async () => {
    const summary = await runDiscovery(query, 'a', ['yellowpages']);

    expect(runGooglePlacesSourceMock).not.toHaveBeenCalled();
    expect(runYellowPagesSourceMock).toHaveBeenCalledTimes(1);
    expect(summary.sources.find((s) => s.source === 'google_places')).toEqual({
      source: 'google_places',
      ran: false,
      reason: 'disabled for this run',
      count: 0,
    });
  });

  it('applies the enabledSources filter to builtwith too, in addition to its own env-var check', async () => {
    envMock.BUILTWITH_API_KEY = 'test-key';
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });

    const summary = await runDiscovery(query, 'a', ['google_places', 'yellowpages']);

    const builtwithSummary = summary.sources.find((s) => s.source === 'builtwith');
    expect(builtwithSummary).toEqual({
      source: 'builtwith',
      ran: false,
      reason: 'disabled for this run',
      count: 0,
    });
    expect(lookupStaleStackMock).not.toHaveBeenCalled();
  });

  it('runs builtwith when it is both configured and included in enabledSources', async () => {
    envMock.BUILTWITH_API_KEY = 'test-key';
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });
    lookupStaleStackMock.mockResolvedValue({ ok: false });

    const summary = await runDiscovery(query, 'a', ['google_places', 'yellowpages', 'builtwith']);

    const builtwithSummary = summary.sources.find((s) => s.source === 'builtwith');
    expect(builtwithSummary?.ran).toBe(true);
  });
});
