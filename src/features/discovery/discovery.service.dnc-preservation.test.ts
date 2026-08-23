import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertDestructiveTestsAllowed } from '@/common/testing/require-destructive-test-guard';

// Integration test against the real Postgres DB (same pattern as
// daily-send-counter.test.ts / prospects.repository.test.ts) - the guarantee
// under test ("a doNotContact:true prospect is left completely untouched by
// re-discovery") is a persistence guarantee, so it's verified with a direct
// DB read after the run rather than trusting the returned summary alone.
// Discovery *sources* are mocked (same as discovery.service.test.ts) since
// only `runDiscovery`'s own persistence branching is under test here; prisma
// itself is real.
const runGooglePlacesSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/google-places.source', () => ({
  runGooglePlacesSource: runGooglePlacesSourceMock,
}));

const runYellowPagesSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/yellowpages.source', () => ({
  runYellowPagesSource: runYellowPagesSourceMock,
}));

// Branch A also runs overpass (no API key required) and the builtwith/
// tech-stack-detector enrichers (BUILTWITH_API_KEY is configured in this
// repo's real .env, which this file's real, unmocked `env` module reads) -
// left unmocked, these make real network calls on every run, which is both
// slow (routinely pushes this file's tests past Vitest's default 5000ms
// timeout) and non-deterministic. Mocked here for the same reason the rest
// of this file's sources are mocked (see the top-of-file comment): only
// `runDiscovery`'s own persistence branching is under test.
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

// Same reasoning as overpass/builtwith/tech-stack-detector above: Branch A
// also runs Companies House and Texas Comptroller, and both read their API
// key from the real, unmocked `env` module. Only harmless today because
// COMPANIES_HOUSE_API_KEY/TEXAS_COMPTROLLER_API_KEY are unset in this repo's
// .env - mocked here so this file doesn't start firing real external
// requests the moment either key is provisioned.
const runCompaniesHouseSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/companies-house.source', () => ({
  runCompaniesHouseSource: runCompaniesHouseSourceMock,
}));

const runTexasComptrollerSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/texas-comptroller.source', () => ({
  runTexasComptrollerSource: runTexasComptrollerSourceMock,
}));

const runProductHuntSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/product-hunt.source', () => ({
  runProductHuntSource: runProductHuntSourceMock,
}));

const runCrunchbaseSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/crunchbase.source', () => ({
  runCrunchbaseSource: runCrunchbaseSourceMock,
}));

// GitHub is enrichment-only (see github.source.ts), not a discovery source -
// still mocked here since `runDiscovery`'s enrichment chain calls it
// unconditionally regardless of branch.
const lookupGitHubEvidenceMock = vi.fn();
vi.mock('@/features/discovery/sources/github.source', () => ({ lookupGitHubEvidence: lookupGitHubEvidenceMock }));

const runIndieHackersSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/indiehackers.source', () => ({
  runIndieHackersSource: runIndieHackersSourceMock,
}));

// Redirects every layer of `runDiscovery`'s own call chain (not just this
// file's direct calls) to the isolated test database - see
// require-destructive-test-guard.ts.
vi.mock('@/common/db/client', async () => {
  const { prisma } = await import('@/common/testing/test-db-client');
  return { prisma };
});

const { prisma } = await import('@/common/testing/test-db-client');
const { runDiscovery } = await import('./discovery.service');

const query = { category: 'plumber', geography: 'Austin, TX' };

beforeAll(() => {
  assertDestructiveTestsAllowed('discovery.service.dnc-preservation.test.ts');
});

beforeEach(async () => {
  await prisma.prospect.deleteMany();
  vi.clearAllMocks();
  runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runYellowPagesSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runOverpassSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  lookupStaleStackMock.mockResolvedValue({ ok: false, reason: 'source unavailable: could not fetch' });
  detectTechStackMock.mockResolvedValue({ ok: false, reason: 'source unavailable: could not fetch' });
  runCompaniesHouseSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runTexasComptrollerSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runProductHuntSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runCrunchbaseSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  lookupGitHubEvidenceMock.mockResolvedValue({ ok: true, lookup: { matched: false, signal: null } });
  runIndieHackersSourceMock.mockResolvedValue({ ok: true, prospects: [] });
});

afterAll(async () => {
  await prisma.prospect.deleteMany();
  await prisma.$disconnect();
});

const ORIGINAL_SIGNAL = { type: 'no_https', description: 'original signal, pre-opt-out', evidence: null, strength: 'weak' };

async function seedDoNotContactProspect(domain: string): Promise<{ id: string }> {
  const created = await prisma.prospect.create({
    data: {
      companyName: 'Original Company Name',
      domain,
      websiteUrl: `https://${domain}`,
      industry: 'local_service',
      location: { city: 'Austin', country: 'US', lat: null, lng: null },
      companySize: 'unknown',
      emailConfidence: 0,
      source: 'google_places',
      sourceUrl: 'https://example.com/source',
      discoveredAt: new Date('2026-01-01T00:00:00.000Z'),
      signal: ORIGINAL_SIGNAL,
      projectFit: 'unclear',
      estimatedBudget: 'unknown',
      priorityScore: 1,
      status: 'unsubscribed',
      doNotContact: true,
    },
  });
  return { id: created.id };
}

describe('runDiscovery doNotContact preservation (real DB)', () => {
  it('leaves an existing doNotContact:true prospect completely untouched when re-discovered by domain, verified via a direct DB read', async () => {
    const domain = `${randomUUID()}.example.com`;
    await seedDoNotContactProspect(domain);

    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        {
          companyName: 'A Very Different Re-Scraped Name',
          domain,
          websiteUrl: `https://${domain}`,
          industry: 'local_service',
          location: { city: 'Denver', country: 'US', lat: null, lng: null },
          companySize: '1-10',
          source: 'google_places',
          sourceUrl: 'https://example.com/rescrape',
          discoveredAt: new Date(),
          signal: { type: 'outdated_site', description: 'freshly re-scraped signal', evidence: 'evidence', strength: 'strong' },
          corroboratingSourceCount: 1,
        },
      ],
    });

    const summary = await runDiscovery(query, 'a');

    expect(summary.skippedDoNotContact).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(0);

    const row = await prisma.prospect.findFirst({ where: { domain } });
    expect(row).not.toBeNull();
    expect(row?.companyName).toBe('Original Company Name');
    expect(row?.signal).toEqual(ORIGINAL_SIGNAL);
    expect(row?.priorityScore).toBe(1);
    expect(row?.location).toEqual({ city: 'Austin', country: 'US', lat: null, lng: null });
    expect(row?.companySize).toBe('unknown');
    expect(row?.doNotContact).toBe(true);
    expect(row?.status).toBe('unsubscribed');
  });

  it('still inserts a genuinely new prospect while a doNotContact:true prospect in the same run is skipped and left untouched', async () => {
    const dncDomain = `${randomUUID()}.example.com`;
    const newDomain = `${randomUUID()}.example.com`;
    await seedDoNotContactProspect(dncDomain);

    runGooglePlacesSourceMock.mockResolvedValue({
      ok: true,
      prospects: [
        {
          companyName: 'Opted-Out Co (re-scraped)',
          domain: dncDomain,
          websiteUrl: `https://${dncDomain}`,
          industry: 'local_service',
          location: { city: 'Austin', country: 'US', lat: null, lng: null },
          companySize: 'unknown',
          source: 'google_places',
          sourceUrl: 'https://example.com/source',
          discoveredAt: new Date(),
          signal: { type: 'no_https', description: 'x', evidence: null, strength: 'weak' },
          corroboratingSourceCount: 1,
        },
        {
          companyName: 'Brand New Co',
          domain: newDomain,
          websiteUrl: `https://${newDomain}`,
          industry: 'local_service',
          location: { city: 'Austin', country: 'US', lat: null, lng: null },
          companySize: 'unknown',
          source: 'google_places',
          sourceUrl: 'https://example.com/source',
          discoveredAt: new Date(),
          signal: { type: 'no_https', description: 'x', evidence: null, strength: 'medium' },
          corroboratingSourceCount: 1,
        },
      ],
    });

    const summary = await runDiscovery(query, 'a');

    expect(summary.skippedDoNotContact).toBe(1);
    expect(summary.inserted).toBe(1);

    const dncRow = await prisma.prospect.findFirst({ where: { domain: dncDomain } });
    expect(dncRow?.companyName).toBe('Original Company Name');
    expect(dncRow?.doNotContact).toBe(true);

    const newRow = await prisma.prospect.findFirst({ where: { domain: newDomain } });
    expect(newRow).not.toBeNull();
    expect(newRow?.companyName).toBe('Brand New Co');
    expect(newRow?.doNotContact).toBe(false);
  });
});
