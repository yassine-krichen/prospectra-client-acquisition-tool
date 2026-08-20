import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/common/db/client';
import { assertDestructiveTestsAllowed } from '@/common/testing/require-destructive-test-guard';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { runRetentionScheduler } from '@/features/retention/retention-scheduler';

// Integration test against the real Postgres DB (DATABASE_URL - the same
// database the app uses, see vitest.setup.ts), same pattern/style as
// followup-scheduler.cap-integration.test.ts. Unlike retention-scheduler.test.ts
// (which mocks `getTodaysSendCount` directly for fast, isolated orchestration
// coverage), this exercises the REAL `daily-send-counter.ts` wired through
// the scheduler's cap check end to end.
//
// `daily-send-counter.ts`'s `getTodaysSendCount()` sums BOTH
// `Prospect.sentAt`/`Prospect.lastFollowupAt` and `Job.lastRetentionTouchAt`
// - a retention send is still a send against the same shared cap. This test
// proves the retention scheduler correctly RESPECTS whatever the shared
// counter reports, using Prospect rows as the "other sends today" filler,
// same technique the followups version of this test uses. It does not prove
// a successful retention send is itself counted by a later run (that would
// need a real `RESEND_API_KEY` for `sendEmail` to succeed rather than roll
// back the claim) - same limitation the followups cap-integration test has.
beforeAll(() => {
  assertDestructiveTestsAllowed('retention-scheduler.cap-integration.test.ts');
});

beforeEach(async () => {
  await prisma.prospect.deleteMany();
  await prisma.job.deleteMany();
  await prisma.client.deleteMany();
});

afterAll(async () => {
  await prisma.prospect.deleteMany();
  await prisma.job.deleteMany();
  await prisma.client.deleteMany();
  await prisma.$disconnect();
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

async function seedFillerProspectSentToday(): Promise<void> {
  const domain = `${randomUUID()}.example.com`;
  await prisma.prospect.create({
    data: {
      companyName: `Test Co ${randomUUID()}`,
      domain,
      websiteUrl: `https://${domain}`,
      industry: 'local_service',
      location: { city: 'Austin', country: 'US', lat: null, lng: null },
      companySize: 'unknown',
      emailConfidence: 0,
      source: 'google_places',
      sourceUrl: 'https://example.com/source',
      discoveredAt: new Date('2026-01-01T00:00:00.000Z'),
      signal: { type: 'no_https', description: 'test fixture', evidence: null, strength: 'medium' },
      projectFit: 'unclear',
      estimatedBudget: 'unknown',
      priorityScore: 1,
      status: 'dead' as never,
      sentAt: new Date(),
    },
  });
}

async function seedDeliveredJob(overrides: { deliveredAt: Date }): Promise<{ id: string }> {
  const client = await prisma.client.create({
    data: {
      companyName: `Test Client ${randomUUID()}`,
      industry: 'local_service',
      companySize: 'unknown',
      contactEmail: 'contact@example.com',
    },
  });

  return prisma.job.create({
    data: {
      clientId: client.id,
      service: 'landing_page',
      cadence: 'one_off',
      status: 'delivered',
      agreedPriceCents: 100_000,
      deliveredAt: overrides.deliveredAt,
    },
  });
}

describe('runRetentionScheduler daily cap enforcement (real daily-send-counter.ts wiring)', () => {
  it('blocks a due Job as skipped_cap once enough OTHER (Prospect) sends today have reached the real effective cap, without ever attempting a claim on it', async () => {
    const cap = getEffectiveDailyCap();

    for (let i = 0; i < cap; i += 1) {
      await seedFillerProspectSentToday();
    }

    const dueJob = await seedDeliveredJob({ deliveredAt: daysAgo(4) });

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: dueJob.id, outcome: 'skipped_cap' }]);

    const reloaded = await prisma.job.findUniqueOrThrow({ where: { id: dueJob.id } });
    expect(reloaded.lastRetentionTouchAt).toBeNull();
    expect(reloaded.retentionTouchCount).toBe(0);
  });
});
