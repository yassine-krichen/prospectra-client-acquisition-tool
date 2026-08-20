import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/common/db/client';
import { getTodaysSendCount } from '@/features/sending/daily-send-counter';

// Integration test against the real Postgres DB (DATABASE_URL - the same
// database the app uses, see vitest.setup.ts), same pattern as
// prospects.repository.test.ts. This is
// the daily-cap enforcement's own read path, so the UTC day boundary math is
// exercised for real rather than mocked - an off-by-one here would let a
// bulk-approve batch quietly exceed the daily cap.
beforeEach(async () => {
  await prisma.job.deleteMany();
  await prisma.client.deleteMany();
  await prisma.prospect.deleteMany();
});

afterAll(async () => {
  await prisma.job.deleteMany();
  await prisma.client.deleteMany();
  await prisma.prospect.deleteMany();
  await prisma.$disconnect();
});

async function seedProspect(sentAt: Date | null, lastFollowupAt: Date | null = null): Promise<void> {
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
      sentAt,
      lastFollowupAt,
    },
  });
}

async function seedJobWithRetentionTouch(lastRetentionTouchAt: Date | null): Promise<void> {
  const client = await prisma.client.create({
    data: {
      companyName: `Test Client ${randomUUID()}`,
      industry: 'local_service',
      companySize: 'unknown',
    },
  });
  await prisma.job.create({
    data: {
      clientId: client.id,
      service: 'landing_page',
      cadence: 'one_off',
      status: 'delivered',
      agreedPriceCents: 100_000,
      lastRetentionTouchAt,
    },
  });
}

describe('getTodaysSendCount', () => {
  const referenceDate = new Date('2026-06-15T12:00:00.000Z');

  it('counts only prospects sent within the reference UTC day, excluding yesterday and never-sent prospects', async () => {
    await seedProspect(new Date('2026-06-15T00:00:00.000Z')); // today, start of day
    await seedProspect(new Date('2026-06-15T23:59:59.999Z')); // today, end of day
    await seedProspect(new Date('2026-06-14T23:59:59.999Z')); // yesterday, 1ms before midnight
    await seedProspect(null); // never sent

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(2);
  });

  it('includes a sentAt exactly at the start of the reference UTC day (start boundary is inclusive)', async () => {
    await seedProspect(new Date('2026-06-15T00:00:00.000Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(1);
  });

  it('excludes a sentAt exactly at the start of the following UTC day (end boundary is exclusive)', async () => {
    await seedProspect(new Date('2026-06-16T00:00:00.000Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(0);
  });

  it('excludes a sentAt 1ms before the reference UTC day begins', async () => {
    await seedProspect(new Date('2026-06-14T23:59:59.999Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(0);
  });

  it('excludes prospects that have never been sent (sentAt null)', async () => {
    await seedProspect(null);

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(0);
  });

  it('returns 0 when nothing has been sent today', async () => {
    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(0);
  });

  it('defaults to counting against the real current UTC day when no referenceDate is given', async () => {
    await seedProspect(new Date());

    const count = await getTodaysSendCount();

    expect(count).toBe(1);
  });

  // A follow-up send (followup-scheduler.ts) only ever sets `lastFollowupAt`,
  // never `sentAt` (which must keep meaning "when the ORIGINAL send went
  // out" - see the module doc comment). Without this, follow-up sends were
  // invisible to the daily cap entirely.
  it('counts a prospect whose ONLY today-timestamp is lastFollowupAt (a follow-up send with no sentAt change today)', async () => {
    await seedProspect(new Date('2026-01-01T00:00:00.000Z'), new Date('2026-06-15T10:00:00.000Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(1);
  });

  it('does not count a prospect whose sentAt and lastFollowupAt both fall outside the reference UTC day', async () => {
    await seedProspect(new Date('2026-01-01T00:00:00.000Z'), new Date('2026-06-10T10:00:00.000Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(0);
  });

  it('still counts via sentAt alone when lastFollowupAt is null, unchanged from Phase 4\'s original-send cap enforcement', async () => {
    await seedProspect(new Date('2026-06-15T08:00:00.000Z'), null);

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(1);
  });

  it('counts a prospect once even if both sentAt and lastFollowupAt fall within today (not double-counted)', async () => {
    await seedProspect(new Date('2026-06-15T01:00:00.000Z'), new Date('2026-06-15T20:00:00.000Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(1);
  });

  // A retention touch (retention-scheduler.ts) sets Job.lastRetentionTouchAt,
  // a separate table from Prospect - without this, retention sends were
  // invisible to the shared daily cap entirely, letting a busy retention day
  // exceed sending-domain volume limits alongside cold outreach.
  it('counts a Job whose lastRetentionTouchAt falls within the reference UTC day', async () => {
    await seedJobWithRetentionTouch(new Date('2026-06-15T10:00:00.000Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(1);
  });

  it('excludes a Job whose lastRetentionTouchAt falls outside the reference UTC day', async () => {
    await seedJobWithRetentionTouch(new Date('2026-06-10T10:00:00.000Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(0);
  });

  it('excludes a Job that has never had a retention touch (lastRetentionTouchAt null)', async () => {
    await seedJobWithRetentionTouch(null);

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(0);
  });

  it('sums prospect sends and Job retention touches from today (not one replacing the other)', async () => {
    await seedProspect(new Date('2026-06-15T08:00:00.000Z'));
    await seedJobWithRetentionTouch(new Date('2026-06-15T10:00:00.000Z'));

    const count = await getTodaysSendCount(referenceDate);

    expect(count).toBe(2);
  });
});
