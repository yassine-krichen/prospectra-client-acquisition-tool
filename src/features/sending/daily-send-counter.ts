import { prisma } from '@/common/db/client';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Midnight UTC for the given date's calendar day. UTC (not local time) so
// the boundary is deterministic regardless of server/deployment timezone.
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Server-enforced count of emails actually sent today (UTC), derived from
 * `Prospect.sentAt` rather than a separate counter table — per the Phase 4
 * spec, counting existing `sentAt` rows avoids introducing a second source
 * of truth that could drift out of sync with what was actually sent. This
 * is the only place send-queue.service.ts asks "how many have gone out
 * today", and it's re-queried before every individual send in a batch (not
 * cached), so a bulk-approve can't blow through the daily cap mid-batch.
 */
export async function getTodaysSendCount(referenceDate: Date = new Date()): Promise<number> {
  const start = startOfUtcDay(referenceDate);
  const end = new Date(start.getTime() + MS_PER_DAY);

  return prisma.prospect.count({
    where: { sentAt: { gte: start, lt: end } },
  });
}
