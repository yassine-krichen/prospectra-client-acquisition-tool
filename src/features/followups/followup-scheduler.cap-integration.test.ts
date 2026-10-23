import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertDestructiveTestsAllowed } from '@/common/testing/require-destructive-test-guard';
import { prisma } from '@/common/testing/test-db-client';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { reserveDailySendSlot } from '@/features/sending/daily-send-counter';
import { FOLLOWUP_INTERVAL_DAYS, runFollowupScheduler } from '@/features/followups/followup-scheduler';

// Redirects every layer of `runFollowupScheduler`'s own call chain (not just
// this file's direct calls) to the isolated test database - see
// require-destructive-test-guard.ts.
// This file exercises the scheduler's own send path against the real cap
// counter, so approval mode is off.
vi.mock('@/features/followups/followup-approval-setting', () => ({
  isFollowupApprovalRequired: () => false,
}));

vi.mock('@/common/db/client', async () => {
  const { prisma } = await import('@/common/testing/test-db-client');
  return { prisma };
});

// Integration test against the real Postgres DB (DATABASE_URL - the same
// database the app uses, see vitest.setup.ts). Unlike followup-scheduler.test.ts
// (which mocks `reserveDailySendSlot` directly for fast, isolated
// orchestration coverage), this exercises the REAL `daily-send-counter.ts`
// wired through the scheduler's cap check end to end - proving the atomic
// `DailySendCounter` reservation (not a `getTodaysSendCount()` read, which
// two concurrent callers could each read stale - see the doc comment on
// `reserveDailySendSlot`) actually blocks a real send once the cap is
// reserved, against real Postgres row-level locking, not a mock.
beforeAll(() => {
  assertDestructiveTestsAllowed('followup-scheduler.cap-integration.test.ts');
});

beforeEach(async () => {
  await prisma.prospect.deleteMany();
  await prisma.dailySendCounter.deleteMany();
});

afterAll(async () => {
  await prisma.prospect.deleteMany();
  await prisma.dailySendCounter.deleteMany();
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
  it('blocks a due candidate as skipped_cap once the real DailySendCounter already has the effective cap reserved, without ever attempting a claim on it', async () => {
    const cap = getEffectiveDailyCap();

    // Reserves every slot for real against the actual TEST_DATABASE_URL
    // Postgres instance (not a mock) - this is what a busy day of real
    // sends/follow-ups/retention touches would have already done by the
    // time this scheduler run starts.
    for (let i = 0; i < cap; i += 1) {
      const reserved = await reserveDailySendSlot(cap);
      expect(reserved).toBe(true);
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

  it('under real concurrent load, exactly `cap` reservations succeed and the rest fail - proving Postgres row-level locking (not application code) closes the race two independent reads never could', async () => {
    const cap = 5;

    // Fires far more concurrent reservation attempts than the cap allows,
    // all racing for the SAME `DailySendCounter` row. If this were a plain
    // `getTodaysSendCount() >= cap` read (the pre-fix bug), most or all of
    // these could read a stale count and succeed, overshooting the cap.
    const attempts = 20;
    const results = await Promise.all(Array.from({ length: attempts }, () => reserveDailySendSlot(cap)));

    const successCount = results.filter(Boolean).length;
    expect(successCount).toBe(cap);
    expect(results.length - successCount).toBe(attempts - cap);
  });
});
