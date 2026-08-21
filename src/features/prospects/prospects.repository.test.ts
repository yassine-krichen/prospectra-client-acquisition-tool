import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertDestructiveTestsAllowed } from '@/common/testing/require-destructive-test-guard';
import { prisma } from '@/common/testing/test-db-client';
import { toPrismaCompanySize } from '@/features/prospects/company-size.mapper';
import { getProspectById, listProspects } from '@/features/prospects/prospects.repository';

// Redirects every layer of `listProspects`/`getProspectById`'s own call
// chain (not just this file's direct calls) to the isolated test database -
// see require-destructive-test-guard.ts.
vi.mock('@/common/db/client', async () => {
  const { prisma } = await import('@/common/testing/test-db-client');
  return { prisma };
});
import type {
  CompanySize,
  Industry,
  ProjectFit,
  ProspectSource,
  ProspectStatus,
  Signal,
} from '@/features/prospects/prospect.types';

// Integration tests against the real Postgres DB (DATABASE_URL - the same
// database the app uses, see vitest.setup.ts). The Prospect table is wiped
// before every test rather than tagged/rolled back: deleteMany is simpler
// than threading a transaction through `listProspects`'s own `prisma`
// import. Deliberate tradeoff: don't run `npm test` against a DATABASE_URL
// holding data you care about - and see require-destructive-test-guard.ts
// for the explicit opt-in this file now refuses to run without.
beforeAll(() => {
  assertDestructiveTestsAllowed('prospects.repository.test.ts');
});

beforeEach(async () => {
  await prisma.prospect.deleteMany();
});

afterAll(async () => {
  await prisma.prospect.deleteMany();
  await prisma.$disconnect();
});

interface SeedOverrides {
  companyName?: string;
  domain?: string;
  source?: ProspectSource;
  industry?: Industry;
  projectFit?: ProjectFit;
  status?: ProspectStatus;
  signal?: Signal;
  companySize?: CompanySize;
  priorityScore?: number;
  emailVerified?: boolean;
  discoveredAt?: Date;
  createdAt?: Date;
  sentAt?: Date | null;
}

const DEFAULT_SIGNAL: Signal = { type: 'no_https', description: 'test fixture', evidence: null, strength: 'medium' };

async function seedProspect(overrides: SeedOverrides = {}): Promise<{ id: string }> {
  const domain = overrides.domain ?? `${randomUUID()}.example.com`;

  return prisma.prospect.create({
    data: {
      companyName: overrides.companyName ?? `Test Co ${randomUUID()}`,
      domain,
      websiteUrl: `https://${domain}`,
      industry: overrides.industry ?? 'local_service',
      location: { city: 'Austin', country: 'US', lat: null, lng: null },
      companySize: toPrismaCompanySize(overrides.companySize ?? 'unknown'),
      emailVerified: overrides.emailVerified ?? false,
      emailConfidence: 0,
      source: overrides.source ?? 'google_places',
      sourceUrl: 'https://example.com/source',
      discoveredAt: overrides.discoveredAt ?? new Date('2026-01-01T00:00:00.000Z'),
      signal: overrides.signal ?? DEFAULT_SIGNAL,
      projectFit: overrides.projectFit ?? 'unclear',
      estimatedBudget: 'unknown',
      priorityScore: overrides.priorityScore ?? 1,
      status: overrides.status ?? 'new',
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      sentAt: overrides.sentAt ?? null,
    },
    select: { id: true },
  });
}

describe('listProspects filters', () => {
  it('filters by source, excluding prospects from other sources', async () => {
    await seedProspect({ source: 'google_places', companyName: 'Kept' });
    await seedProspect({ source: 'manual', companyName: 'Excluded' });

    const { prospects } = await listProspects({ filters: { source: 'google_places' } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('filters by industry, excluding prospects from other industries', async () => {
    await seedProspect({ industry: 'saas', companyName: 'Kept' });
    await seedProspect({ industry: 'agency', companyName: 'Excluded' });

    const { prospects } = await listProspects({ filters: { industry: 'saas' } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('filters by projectFit, excluding prospects with a different fit', async () => {
    await seedProspect({ projectFit: 'landing_page', companyName: 'Kept' });
    await seedProspect({ projectFit: 'backend_api', companyName: 'Excluded' });

    const { prospects } = await listProspects({ filters: { projectFit: 'landing_page' } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('filters by status, excluding prospects in a different status', async () => {
    await seedProspect({ status: 'new', companyName: 'Kept' });
    await seedProspect({ status: 'won', companyName: 'Excluded' });

    const { prospects } = await listProspects({ filters: { status: 'new' } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('filters by hasVerifiedEmail=true, excluding prospects without a verified email', async () => {
    await seedProspect({ emailVerified: true, companyName: 'Kept' });
    await seedProspect({ emailVerified: false, companyName: 'Excluded' });

    const { prospects } = await listProspects({ filters: { hasVerifiedEmail: true } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('filters by hasVerifiedEmail=false, excluding prospects with a verified email', async () => {
    await seedProspect({ emailVerified: true, companyName: 'Excluded' });
    await seedProspect({ emailVerified: false, companyName: 'Kept' });

    const { prospects } = await listProspects({ filters: { hasVerifiedEmail: false } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('filters by signalType, a field nested inside the signal Json column', async () => {
    await seedProspect({ signal: { ...DEFAULT_SIGNAL, type: 'no_website' }, companyName: 'Kept' });
    await seedProspect({ signal: { ...DEFAULT_SIGNAL, type: 'old_stack' }, companyName: 'Excluded' });

    const { prospects } = await listProspects({ filters: { signalType: 'no_website' } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('filters by signalStrength, a field nested inside the signal Json column', async () => {
    await seedProspect({ signal: { ...DEFAULT_SIGNAL, strength: 'strong' }, companyName: 'Kept' });
    await seedProspect({ signal: { ...DEFAULT_SIGNAL, strength: 'weak' }, companyName: 'Excluded' });

    const { prospects } = await listProspects({ filters: { signalStrength: 'strong' } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('combines signalType and signalStrength filters as an AND, not an OR', async () => {
    await seedProspect({ signal: { ...DEFAULT_SIGNAL, type: 'no_website', strength: 'strong' }, companyName: 'Kept' });
    // Matches signalType alone.
    await seedProspect({ signal: { ...DEFAULT_SIGNAL, type: 'no_website', strength: 'weak' }, companyName: 'WrongStrength' });
    // Matches signalStrength alone.
    await seedProspect({ signal: { ...DEFAULT_SIGNAL, type: 'old_stack', strength: 'strong' }, companyName: 'WrongType' });

    const { prospects } = await listProspects({
      filters: { signalType: 'no_website', signalStrength: 'strong' },
    });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('filters by an inclusive priorityScore range', async () => {
    await seedProspect({ priorityScore: 1, companyName: 'TooLow' });
    await seedProspect({ priorityScore: 2, companyName: 'Kept' });
    await seedProspect({ priorityScore: 3, companyName: 'AlsoKept' });
    await seedProspect({ priorityScore: 4, companyName: 'TooHigh' });

    const { prospects } = await listProspects({ filters: { priorityScoreMin: 2, priorityScoreMax: 3 } });

    expect(prospects.map((p) => p.companyName).sort()).toEqual(['AlsoKept', 'Kept']);
  });

  it('applies only a priorityScoreMin bound when priorityScoreMax is not given', async () => {
    await seedProspect({ priorityScore: 1, companyName: 'Excluded' });
    await seedProspect({ priorityScore: 5, companyName: 'Kept' });

    const { prospects } = await listProspects({ filters: { priorityScoreMin: 3 } });

    expect(prospects.map((p) => p.companyName)).toEqual(['Kept']);
  });

  it('returns every prospect when no filters are given', async () => {
    await seedProspect({ companyName: 'One' });
    await seedProspect({ companyName: 'Two' });

    const { prospects } = await listProspects();

    expect(prospects).toHaveLength(2);
  });
});

describe('listProspects sorting', () => {
  it('sorts by priorityScore descending by default direction', async () => {
    await seedProspect({ priorityScore: 1, companyName: 'Low' });
    await seedProspect({ priorityScore: 3, companyName: 'High' });
    await seedProspect({ priorityScore: 2, companyName: 'Mid' });

    const { prospects } = await listProspects({ sortField: 'priorityScore', sortDirection: 'desc' });

    expect(prospects.map((p) => p.companyName)).toEqual(['High', 'Mid', 'Low']);
  });

  it('sorts by priorityScore ascending when requested', async () => {
    await seedProspect({ priorityScore: 1, companyName: 'Low' });
    await seedProspect({ priorityScore: 3, companyName: 'High' });
    await seedProspect({ priorityScore: 2, companyName: 'Mid' });

    const { prospects } = await listProspects({ sortField: 'priorityScore', sortDirection: 'asc' });

    expect(prospects.map((p) => p.companyName)).toEqual(['Low', 'Mid', 'High']);
  });

  it('sorts by discoveredAt descending by default (default sortField and direction)', async () => {
    await seedProspect({ discoveredAt: new Date('2026-01-01'), companyName: 'Oldest' });
    await seedProspect({ discoveredAt: new Date('2026-03-01'), companyName: 'Newest' });
    await seedProspect({ discoveredAt: new Date('2026-02-01'), companyName: 'Middle' });

    const { prospects } = await listProspects();

    expect(prospects.map((p) => p.companyName)).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('sorts by sentAt ascending when requested', async () => {
    await seedProspect({ sentAt: new Date('2026-01-03'), companyName: 'Last' });
    await seedProspect({ sentAt: new Date('2026-01-01'), companyName: 'First' });
    await seedProspect({ sentAt: new Date('2026-01-02'), companyName: 'Second' });

    const { prospects } = await listProspects({ sortField: 'sentAt', sortDirection: 'asc' });

    expect(prospects.map((p) => p.companyName)).toEqual(['First', 'Second', 'Last']);
  });
});

describe('listProspects cursor pagination', () => {
  it('pages through all results exactly once each, in stable discoveredAt-desc order, when creation order matches discoveredAt order', async () => {
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(
        await seedProspect({
          companyName: `Prospect ${i}`,
          discoveredAt: new Date(2026, 0, i + 1),
        })
      );
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let safetyCounter = 0;
    do {
      const page = await listProspects({ limit: 2, cursor });
      collected.push(...page.prospects.map((p) => p.id));
      cursor = page.nextCursor ?? undefined;
      safetyCounter += 1;
    } while (cursor && safetyCounter < 10);

    expect(collected).toHaveLength(5);
    expect(new Set(collected).size).toBe(5);
    // discoveredAt desc means the most-recently-discovered (highest day) comes first.
    expect(collected).toEqual([...seeded].reverse().map((s) => s.id));
  });

  it('does not skip or repeat a prospect across pages when discoveredAt order diverges from creation order', async () => {
    // Seeded in createdAt order p0..p4, but discoveredAt values deliberately
    // out of step with creation order so the default display sort
    // (discoveredAt desc) disagrees with insertion/createdAt order.
    const discoveredAtByIndex = [1, 5, 3, 4, 2];
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(
        await seedProspect({
          companyName: `Prospect ${i}`,
          discoveredAt: new Date(2026, 0, discoveredAtByIndex[i]),
        })
      );
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let safetyCounter = 0;
    do {
      const page = await listProspects({ limit: 2, cursor });
      collected.push(...page.prospects.map((p) => p.id));
      cursor = page.nextCursor ?? undefined;
      safetyCounter += 1;
    } while (cursor && safetyCounter < 10);

    const seededIds = seeded.map((s) => s.id);
    expect(new Set(collected).size).toBe(collected.length); // no repeats
    expect(collected.sort()).toEqual(seededIds.sort()); // no skips - same set of ids
  });

  it('does not repeat or skip items when paging with a non-default sortField (priorityScore)', async () => {
    const seeded = [];
    for (let i = 0; i < 5; i++) {
      seeded.push(await seedProspect({ companyName: `Prospect ${i}`, priorityScore: i }));
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let safetyCounter = 0;
    do {
      const page = await listProspects({ limit: 2, cursor, sortField: 'priorityScore', sortDirection: 'desc' });
      collected.push(...page.prospects.map((p) => p.id));
      cursor = page.nextCursor ?? undefined;
      safetyCounter += 1;
    } while (cursor && safetyCounter < 10);

    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.sort()).toEqual(seeded.map((s) => s.id).sort());
  });

  it('returns a null nextCursor on the final page', async () => {
    await seedProspect({ companyName: 'Only one' });

    const { nextCursor } = await listProspects({ limit: 25 });

    expect(nextCursor).toBeNull();
  });
});

describe('listProspects projection', () => {
  it('round-trips companySize through the repository as the domain-readable value, not the Prisma enum member name', async () => {
    await seedProspect({ companySize: '11-50', companyName: 'Sized' });

    const { prospects } = await listProspects();

    expect(prospects[0].companySize).toBe('11-50');
  });
});

describe('getProspectById', () => {
  it('returns null when no prospect exists with the given id', async () => {
    expect(await getProspectById(randomUUID())).toBeNull();
  });

  it('returns the full prospect with contact fields null for a never-enriched (status: new) prospect', async () => {
    const { id } = await seedProspect({ companyName: 'Not Yet Enriched', status: 'new' });

    const prospect = await getProspectById(id);

    expect(prospect?.status).toBe('new');
    expect(prospect?.contactName).toBeNull();
    expect(prospect?.contactEmail).toBeNull();
    expect(prospect?.emailConfidence).toBe(0);
    expect(prospect?.drafts).toEqual([]);
  });

  it('returns real contact info and drafts (with modelUsed mapped to the domain hyphenated form) for an enriched prospect', async () => {
    const { id } = await seedProspect({ companyName: 'Enriched Co', status: 'drafted' });
    await prisma.prospect.update({
      where: { id },
      data: { contactName: 'Jane Doe', contactEmail: 'jane@example.com', emailVerified: true, emailConfidence: 90 },
    });
    await prisma.draft.create({
      data: {
        prospectId: id,
        variant: 1,
        subject: 'Subject',
        body: 'Body',
        modelUsed: 'claude_bridge',
        framework: 'pas',
        approved: false,
        edited: false,
      },
    });

    const prospect = await getProspectById(id);

    expect(prospect?.contactName).toBe('Jane Doe');
    expect(prospect?.contactEmail).toBe('jane@example.com');
    expect(prospect?.emailVerified).toBe(true);
    expect(prospect?.drafts).toHaveLength(1);
    expect(prospect?.drafts[0].modelUsed).toBe('claude-bridge');
  });
});
