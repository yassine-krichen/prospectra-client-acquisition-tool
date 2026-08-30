import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertDestructiveTestsAllowed } from '@/common/testing/require-destructive-test-guard';
import { prisma } from '@/common/testing/test-db-client';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { reserveDailySendSlot } from '@/features/sending/daily-send-counter';
import { runRetentionScheduler } from '@/features/retention/retention-scheduler';

// Redirects every layer of `runRetentionScheduler`'s own call chain (not
// just this file's direct calls) to the isolated test database - see
// require-destructive-test-guard.ts.
vi.mock('@/common/db/client', async () => {
  const { prisma } = await import('@/common/testing/test-db-client');
  return { prisma };
});

// Integration test against the real Postgres DB (DATABASE_URL - the same
// database the app uses, see vitest.setup.ts), same pattern/style as
// followup-scheduler.cap-integration.test.ts. Unlike retention-scheduler.test.ts
// (which mocks `reserveDailySendSlot` directly for fast, isolated
// orchestration coverage), this exercises the REAL `daily-send-counter.ts`
// wired through the scheduler's cap check end to end - proving the atomic
// `DailySendCounter` reservation (shared across sends, follow-ups, and
// retention touches - a retention send is still a send against the same
// cap) actually blocks a real claim once reserved, against real Postgres
// row-level locking, not a mock. It does not prove a successful retention
// send is itself counted by a later run (that would need a real
// `RESEND_API_KEY` for `sendEmail` to succeed rather than roll back the
// claim) - same limitation the followups cap-integration test has.
beforeAll(() => {
  assertDestructiveTestsAllowed('retention-scheduler.cap-integration.test.ts');
});

beforeEach(async () => {
  await prisma.prospect.deleteMany();
  await prisma.job.deleteMany();
  await prisma.client.deleteMany();
  await prisma.dailySendCounter.deleteMany();
});

afterAll(async () => {
  await prisma.prospect.deleteMany();
  await prisma.job.deleteMany();
  await prisma.client.deleteMany();
  await prisma.dailySendCounter.deleteMany();
  await prisma.$disconnect();
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
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
  it('blocks a due Job as skipped_cap once the real DailySendCounter already has the effective cap reserved, without ever attempting a claim on it', async () => {
    const cap = getEffectiveDailyCap();

    for (let i = 0; i < cap; i += 1) {
      const reserved = await reserveDailySendSlot(cap);
      expect(reserved).toBe(true);
    }

    const dueJob = await seedDeliveredJob({ deliveredAt: daysAgo(4) });

    const outcomes = await runRetentionScheduler();

    expect(outcomes).toEqual([{ jobId: dueJob.id, outcome: 'skipped_cap' }]);

    const reloaded = await prisma.job.findUniqueOrThrow({ where: { id: dueJob.id } });
    expect(reloaded.lastRetentionTouchAt).toBeNull();
    expect(reloaded.retentionTouchCount).toBe(0);
  });

  it('under real concurrent load, exactly `cap` reservations succeed and the rest fail - the same shared counter send-queue.service.ts and followup-scheduler.ts also reserve against', async () => {
    const cap = 5;

    const attempts = 20;
    const results = await Promise.all(Array.from({ length: attempts }, () => reserveDailySendSlot(cap)));

    const successCount = results.filter(Boolean).length;
    expect(successCount).toBe(cap);
    expect(results.length - successCount).toBe(attempts - cap);
  });
});
