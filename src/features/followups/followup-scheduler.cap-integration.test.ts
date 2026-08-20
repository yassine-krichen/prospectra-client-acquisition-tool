import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/common/db/client';
import { assertDestructiveTestsAllowed } from '@/common/testing/require-destructive-test-guard';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { FOLLOWUP_INTERVAL_DAYS, runFollowupScheduler } from '@/features/followups/followup-scheduler';

// Integration test against the real Postgres DB (DATABASE_URL - the same
// database the app uses, see vitest.setup.ts). Unlike followup-scheduler.test.ts (which mocks
// `getTodaysSendCount` directly for fast, isolated orchestration coverage),
// this exercises the REAL `daily-send-counter.ts` wired through the
// scheduler's cap check end to end - proving Finding 2's fix (the counter
// must also recognize a today `lastFollowupAt`, not just `sentAt`) actually
// takes effect in the real send path, not just in the counter's own unit
// tests.
beforeAll(() => {
  assertDestructiveTestsAllowed('followup-scheduler.cap-integration.test.ts');
});

beforeEach(async () => {
  await prisma.prospect.deleteMany();
});

afterAll(async () => {
  await prisma.prospect.deleteMany();
  await prisma.$disconnect();
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

interface SeedOverrides {
  status: string;
  sentAt?: Date | null;
  lastFollowupAt?: Date | null;
  contactEmail?: string | null;
}

async function seedProspect(overrides: SeedOverrides): Promise<{ id: string }> {
  const domain = `${randomUUID()}.example.com`;
  return prisma.prospect.create({
    data: {
      companyName: `Test Co ${randomUUID()}`,
      domain,
      websiteUrl: `https://${domain}`,
      industry: 'local_service',
      location: { city: 'Austin', country: 'US', lat: null, lng: null },
      companySize: 'unknown',
      contactEmail: overrides.contactEmail === undefined ? 'contact@example.com' : overrides.contactEmail,
      emailConfidence: 0,
      source: 'google_places',
      sourceUrl: 'https://example.com/source',
      discoveredAt: new Date('2026-01-01T00:00:00.000Z'),
      signal: { type: 'no_https', description: 'test fixture', evidence: null, strength: 'medium' },
      projectFit: 'unclear',
      estimatedBudget: 'unknown',
      priorityScore: 1,
      status: overrides.status as never,
      sentAt: overrides.sentAt ?? null,
      lastFollowupAt: overrides.lastFollowupAt ?? null,
    },
  });
}

describe('runFollowupScheduler daily cap enforcement (real daily-send-counter.ts wiring)', () => {
  it('blocks a due candidate as skipped_cap once enough OTHER prospects have a today lastFollowupAt to reach the real effective cap, without ever attempting a claim on it', async () => {
    const cap = getEffectiveDailyCap();

    // Filler rows that are already terminal (`dead`) - never candidates for
    // this scheduler run (findMany only selects in-flight statuses) - whose
    // ONLY today-timestamp is `lastFollowupAt`. If the counter still only
    // looked at `sentAt` (the pre-fix bug), these would be invisible and the
    // cap check below would wrongly let the due candidate through.
    for (let i = 0; i < cap; i += 1) {
      await seedProspect({ status: 'dead', lastFollowupAt: new Date() });
    }

    const dueCandidate = await seedProspect({
      status: 'sent',
      sentAt: daysAgo(FOLLOWUP_INTERVAL_DAYS + 1),
    });

    const outcomes = await runFollowupScheduler();

    expect(outcomes).toEqual([{ prospectId: dueCandidate.id, outcome: 'skipped_cap' }]);

    const reloaded = await prisma.prospect.findUniqueOrThrow({ where: { id: dueCandidate.id } });
    expect(reloaded.status).toBe('sent');
    expect(reloaded.lastFollowupAt).toBeNull();
  });
});
