import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const runProductHuntSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/product-hunt.source', () => ({
  runProductHuntSource: runProductHuntSourceMock,
}));

const runCrunchbaseSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/crunchbase.source', () => ({
  runCrunchbaseSource: runCrunchbaseSourceMock,
}));

const runGitHubSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/github.source', () => ({ runGitHubSource: runGitHubSourceMock }));

const runIndieHackersSourceMock = vi.fn();
vi.mock('@/features/discovery/sources/indiehackers.source', () => ({
  runIndieHackersSource: runIndieHackersSourceMock,
}));

const { prisma } = await import('@/common/db/client');
const { runDiscovery } = await import('./discovery.service');

const query = { category: 'plumber', geography: 'Austin, TX' };

beforeEach(async () => {
  await prisma.prospect.deleteMany();
  vi.clearAllMocks();
  runGooglePlacesSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runYellowPagesSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runProductHuntSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runCrunchbaseSourceMock.mockResolvedValue({ ok: true, prospects: [] });
  runGitHubSourceMock.mockResolvedValue({ ok: true, prospects: [] });
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
