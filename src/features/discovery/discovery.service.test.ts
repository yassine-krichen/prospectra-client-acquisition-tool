import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveredProspect, DiscoveryQuery } from '@/features/discovery/discovery.types';
import { buildRegistrySignal } from '@/features/discovery/sources/registry-signal';
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

const runOverpassSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/overpass.source', () => ({
  runOverpassSource: runOverpassSourceMock,
}));

const lookupStaleStackMock = vi.fn();
vi.mock('@/features/discovery/sources/builtwith.source', () => ({
  lookupStaleStack: lookupStaleStackMock,
}));

const detectTechStackMock = vi.fn();
vi.mock('@/features/discovery/sources/tech-stack-detector.source', () => ({
  detectTechStack: detectTechStackMock,
}));

const runProductHuntSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/product-hunt.source', () => ({
  runProductHuntSource: runProductHuntSourceMock,
}));

const runCrunchbaseSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/crunchbase.source', () => ({
  runCrunchbaseSource: runCrunchbaseSourceMock,
}));

const lookupGitHubEvidenceMock = vi.fn();
vi.mock('@/features/discovery/sources/github.source', () => ({
  lookupGitHubEvidence: lookupGitHubEvidenceMock,
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
    phone: null,
    address: null,
    corroboratingSourceCount: 1,
    ...overrides,
  };
}

const query: DiscoveryQuery = { category: 'plumber', geography: 'Austin, TX' };

beforeEach(() => {
  vi.clearAllMocks();
  envMock.BUILTWITH_API_KEY = undefined;
  runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runYellowPagesSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runOverpassSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runProductHuntSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runCrunchbaseSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runIndieHackersSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  detectTechStackMock.mockResolvedValue({ ok: false, reason: 'source unavailable: could not fetch' });
  lookupGitHubEvidenceMock.mockResolvedValue({ ok: true, lookup: { matched: false, signal: null } });
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
    findFirstMock.mockResolvedValue({ id: 'existing-id', corroboratingSourceCount: 1 });

    const summary = await runDiscovery(query);

    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'existing-id' } })
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('adds this run\'s corroboratingSourceCount to the persisted row\'s existing count (monotonic), rather than overwriting it', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [buildProspect()] });
    findFirstMock.mockResolvedValue({ id: 'existing-id', corroboratingSourceCount: 3 });

    await runDiscovery(query);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ corroboratingSourceCount: 4 }) })
    );
  });

  it('updates instead of inserting when a no-domain prospect matches an existing record by normalized phone', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: null, phone: '(512) 766-0970' })],
    });
    // First findFirst call is the domain lookup (skipped because domain is
    // null - see the implementation guard), so the phone lookup is the first
    // one actually invoked here.
    findFirstMock.mockResolvedValueOnce({ id: 'existing-id', corroboratingSourceCount: 1 });

    const summary = await runDiscovery(query);

    expect(summary.updated).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(findFirstMock).toHaveBeenCalledWith({ where: { phone: '5127660970' } });
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'existing-id' } }));
  });

  it('updates instead of inserting when a no-domain, no-phone prospect matches an existing record by normalized address', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: null, phone: null, address: '123 Main St' })],
    });
    findFirstMock.mockResolvedValueOnce({ id: 'existing-id', corroboratingSourceCount: 1 });

    const summary = await runDiscovery(query);

    expect(summary.updated).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(findFirstMock).toHaveBeenCalledWith({ where: { address: '123 main street' } });
  });

  it('never re-inserts a no-domain prospect on every re-discovery run once it matches by phone', async () => {
    // Regression guard for the cross-run duplication bug this change fixes:
    // before this fix, a no-domain prospect always fell through to create().
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: null, phone: '512-766-0970' })],
    });
    findFirstMock.mockResolvedValueOnce({ id: 'existing-id', corroboratingSourceCount: 1 });

    await runDiscovery(query);

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
    findFirstMock.mockResolvedValue({ id: 'existing-id', corroboratingSourceCount: 1 });

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
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ corroboratingSourceCount: 2 }) })
    );
  });

  it('accumulates corroboratingSourceCount across more than two sources reporting the same domain', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'acme.com', companyName: 'From Google' })],
    });
    runYellowPagesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'acme.com', companyName: 'From YellowPages' })],
    });
    runOverpassSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'acme.com', companyName: 'From Overpass' })],
    });

    await runDiscovery(query);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ corroboratingSourceCount: 3 }) })
    );
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

  it('dedupes two no-domain prospects reporting the same normalized phone number', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: null, phone: '(512) 766-0970', companyName: 'From Google' })],
    });
    runYellowPagesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: null, phone: '512-766-0970', companyName: 'From YellowPages' })],
    });

    const summary = await runDiscovery(query);

    expect(summary.totalFound).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ corroboratingSourceCount: 2 }) })
    );
  });

  it('dedupes two no-domain, no-phone prospects reporting the same normalized address', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({ domain: null, address: '123 Main St', companyName: 'From Google' }),
      ],
    });
    runYellowPagesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({ domain: null, address: '123 Main Street', companyName: 'From YellowPages' }),
      ],
    });

    const summary = await runDiscovery(query);

    expect(summary.totalFound).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ corroboratingSourceCount: 2 }) })
    );
  });

  it('does not dedupe two no-domain prospects with different phone and address', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({ domain: null, phone: '512-111-1111', address: '1 First St' }),
        buildProspect({ domain: null, phone: '512-222-2222', address: '2 Second St' }),
      ],
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
      expect.objectContaining({ data: expect.objectContaining({ signal: staleStackSignal, priorityScore: 45 }) })
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
      expect.objectContaining({ data: expect.objectContaining({ signal: strongExistingSignal, priorityScore: 45 }) })
    );
  });

  it('upgrades a prospect signal with a stronger tech-stack-detector signal, and reports it under tech_stack_detector', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ signal: buildSignal({ strength: 'weak' }) })],
    });
    const detectedSignal = buildSignal({ type: 'old_stack', strength: 'strong', description: 'WordPress, no modern layer' });
    detectTechStackMock.mockResolvedValue({
      ok: true,
      lookup: { domain: 'acme.com', technologies: ['WordPress'], signal: detectedSignal },
    } satisfies StaleStackResult);

    const summary = await runDiscovery(query);

    const techStackSummary = summary.sources.find((s) => s.source === 'tech_stack_detector');
    expect(techStackSummary?.ran).toBe(true);
    expect(techStackSummary?.count).toBe(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signal: detectedSignal, priorityScore: 45 }) })
    );
  });

  it('does not run the tech-stack detector on a prospect with no websiteUrl', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ websiteUrl: null })],
    });

    const summary = await runDiscovery(query);

    expect(detectTechStackMock).not.toHaveBeenCalled();
    const techStackSummary = summary.sources.find((s) => s.source === 'tech_stack_detector');
    expect(techStackSummary?.count).toBe(0);
  });

  it('lets BuiltWith further strengthen a signal the tech-stack detector already upgraded, since enrichers chain in order', async () => {
    envMock.BUILTWITH_API_KEY = 'test-key';
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ signal: buildSignal({ strength: 'weak' }) })],
    });
    const techStackSignal = buildSignal({ type: 'old_stack', strength: 'medium', description: 'jQuery 2.x' });
    detectTechStackMock.mockResolvedValue({
      ok: true,
      lookup: { domain: 'acme.com', technologies: ['jQuery 2.2.4'], signal: techStackSignal },
    } satisfies StaleStackResult);
    const builtwithSignal = buildSignal({ type: 'old_stack', strength: 'strong', description: 'jQuery 1.x' });
    lookupStaleStackMock.mockResolvedValue({
      ok: true,
      lookup: { domain: 'acme.com', technologies: ['jQuery 1.9.1'], signal: builtwithSignal },
    } satisfies StaleStackResult);

    const summary = await runDiscovery(query);

    expect(summary.sources.find((s) => s.source === 'tech_stack_detector')?.count).toBe(1);
    expect(summary.sources.find((s) => s.source === 'builtwith')?.count).toBe(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signal: builtwithSignal, priorityScore: 45 }) })
    );
  });

  it('does not run GitHub enrichment on a non-saas prospect, to conserve GitHub\'s tight unauthenticated rate limit', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ industry: 'local_service' })],
    });

    const summary = await runDiscovery(query);

    expect(lookupGitHubEvidenceMock).not.toHaveBeenCalled();
    expect(summary.sources.find((s) => s.source === 'github')).toEqual({ source: 'github', ran: true, count: 0 });
  });

  it('upgrades a saas prospect signal with a stronger GitHub evidence signal', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ industry: 'saas', signal: buildSignal({ strength: 'weak' }) })],
    });
    const githubSignal = buildSignal({ type: 'hiring_post', strength: 'medium', description: 'hiring keyword found' });
    lookupGitHubEvidenceMock.mockResolvedValue({ ok: true, lookup: { matched: true, signal: githubSignal } });

    const summary = await runDiscovery(query);

    expect(lookupGitHubEvidenceMock).toHaveBeenCalledTimes(1);
    const githubSummary = summary.sources.find((s) => s.source === 'github');
    expect(githubSummary?.ran).toBe(true);
    expect(githubSummary?.count).toBe(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signal: githubSignal }) })
    );
  });

  it('does not downgrade a saas prospect signal when GitHub reports a weaker signal than already found', async () => {
    const strongExistingSignal = buildSignal({ strength: 'strong', description: 'no https' });
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ industry: 'saas', signal: strongExistingSignal })],
    });
    lookupGitHubEvidenceMock.mockResolvedValue({
      ok: true,
      lookup: { matched: true, signal: buildSignal({ type: 'hiring_post', strength: 'weak' }) },
    });

    const summary = await runDiscovery(query);

    expect(summary.sources.find((s) => s.source === 'github')?.count).toBe(0);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ signal: strongExistingSignal }) })
    );
  });

  it('reports github as skipped-for-this-run when it is filtered out via enabledSources', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ industry: 'saas' })],
    });

    const summary = await runDiscovery(query, 'a', ['google_places', 'yellowpages']);

    expect(lookupGitHubEvidenceMock).not.toHaveBeenCalled();
    expect(summary.sources.find((s) => s.source === 'github')).toEqual({
      source: 'github',
      ran: false,
      reason: 'disabled for this run',
      count: 0,
    });
  });

  it.each([
    ['strong', 45],
    ['medium', 35],
    ['weak', 25],
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
    expect(runOverpassSourceMock).toHaveBeenCalledTimes(1);
    expect(runProductHuntSourceMock).not.toHaveBeenCalled();
    expect(runCrunchbaseSourceMock).not.toHaveBeenCalled();
    expect(runIndieHackersSourceMock).not.toHaveBeenCalled();
  });

  it('runs only Branch A sources when branch is explicitly "a"', async () => {
    const summary = await runDiscovery(query, 'a');

    expect(summary.sources.map((s) => s.source).sort()).toEqual([
      'builtwith',
      'companies_house',
      'github',
      'google_places',
      'overpass',
      'tech_stack_detector',
      'texas_comptroller',
      'yellowpages',
    ]);
    expect(runProductHuntSourceMock).not.toHaveBeenCalled();
  });

  it('runs only Branch B sources (product_hunt, crunchbase, indiehackers) when branch is "b" - GitHub is not a Branch B source, it enriches regardless of branch', async () => {
    const summary = await runDiscovery(query, 'b');

    expect(runGooglePlacesSourceMock).not.toHaveBeenCalled();
    expect(runYellowPagesSourceMock).not.toHaveBeenCalled();
    expect(runOverpassSourceMock).not.toHaveBeenCalled();
    expect(runProductHuntSourceMock).toHaveBeenCalledTimes(1);
    expect(runCrunchbaseSourceMock).toHaveBeenCalledTimes(1);
    expect(runIndieHackersSourceMock).toHaveBeenCalledTimes(1);
    expect(summary.sources.map((s) => s.source).sort()).toEqual([
      'builtwith',
      'crunchbase',
      'github',
      'indiehackers',
      'product_hunt',
      'tech_stack_detector',
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
    expect(runOverpassSourceMock).toHaveBeenCalledTimes(1);
    expect(runProductHuntSourceMock).toHaveBeenCalledTimes(1);
    expect(runCrunchbaseSourceMock).toHaveBeenCalledTimes(1);
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
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ corroboratingSourceCount: 2 }) })
    );
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

describe('runDiscovery thin-prospect filter', () => {
  // The exact baseline signal `buildNoSignalDetectedFallback` produces (see
  // signal-detection.ts) - `evidence` is deliberately varied per test since
  // the filter (`isBaselineSignal`) ignores it.
  function buildBaselineSignal(evidence: string | null = null): Signal {
    return {
      type: 'technical_debt',
      description: 'No specific signal detected on the site; included via category+geography match',
      evidence,
      strength: 'weak',
    };
  }

  it('discards a prospect with no domain/website/phone/address and only a baseline signal', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({ domain: null, websiteUrl: null, phone: null, address: null, signal: buildBaselineSignal() }),
      ],
    });

    const summary = await runDiscovery(query);

    expect(summary.discardedThinProspects).toBe(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('keeps a domain-less, contact-less prospect when it has a genuine (non-baseline) signal', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({ domain: null, websiteUrl: null, phone: null, address: null, signal: buildSignal({ type: 'no_website', strength: 'strong' }) }),
      ],
    });

    const summary = await runDiscovery(query);

    expect(summary.discardedThinProspects).toBe(0);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a baseline-signal prospect when it has a domain', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [buildProspect({ domain: 'acme.com', phone: null, address: null, signal: buildBaselineSignal() })],
    });

    const summary = await runDiscovery(query);

    expect(summary.discardedThinProspects).toBe(0);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a baseline-signal, domain-less prospect when it has a phone', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({ domain: null, websiteUrl: null, phone: '512-555-0100', address: null, signal: buildBaselineSignal() }),
      ],
    });

    const summary = await runDiscovery(query);

    expect(summary.discardedThinProspects).toBe(0);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a baseline-signal, domain-less, phone-less prospect when it has an address', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({ domain: null, websiteUrl: null, phone: null, address: '123 Main St', signal: buildBaselineSignal() }),
      ],
    });

    const summary = await runDiscovery(query);

    expect(summary.discardedThinProspects).toBe(0);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('does not count a thin prospect toward skippedDoNotContact/inserted/updated', async () => {
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({ domain: null, websiteUrl: null, phone: null, address: null, signal: buildBaselineSignal() }),
      ],
    });

    const summary = await runDiscovery(query);

    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.skippedDoNotContact).toBe(0);
  });

  it('discards a registry-source (Companies House/Texas Comptroller) prospect with no contact info and only buildRegistrySignal\'s own fallback', async () => {
    // Registry sources build their fallback signal via `buildRegistrySignal`,
    // a different call site than `buildBaselineSignal` above (which mirrors
    // `buildNoSignalDetectedFallback`) - this confirms the thin-prospect
    // filter recognizes both, not just one hardcoded fallback shape.
    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        buildProspect({
          domain: null,
          websiteUrl: null,
          phone: null,
          address: null,
          source: 'companies_house',
          signal: buildRegistrySignal(null, 'UK Companies House'),
        }),
      ],
    });

    const summary = await runDiscovery(query);

    expect(summary.discardedThinProspects).toBe(1);
    expect(createMock).not.toHaveBeenCalled();
  });
});
