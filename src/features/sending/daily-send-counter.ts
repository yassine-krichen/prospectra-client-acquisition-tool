import { prisma } from '@/common/db/client';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Midnight UTC for the given date's calendar day. UTC (not local time) so
// the boundary is deterministic regardless of server/deployment timezone.
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Server-enforced count of emails actually sent today (UTC), derived from
 * `Prospect.sentAt`/`Prospect.lastFollowupAt` rather than a separate counter
 * table — per the Phase 4 spec, counting existing timestamp columns avoids
 * introducing a second source of truth that could drift out of sync with
 * what was actually sent. This is the only place send-queue.service.ts and
 * followup-scheduler.ts ask "how many have gone out today", and it's
 * re-queried before every individual send in a batch (not cached), so a
 * bulk-approve or a follow-up run can't blow through the daily cap mid-batch.
 *
 * `sentAt` is set once, by the original send (send-queue.service.ts), and
 * must keep meaning exactly that — it is never overwritten by a follow-up.
 * `lastFollowupAt` is set on every subsequent follow-up touch
 * (followup-scheduler.ts). A follow-up send is still a send, so a prospect
 * counts toward today's total if EITHER timestamp falls in today's UTC
 * window — an `OR`, not a replacement of the `sentAt` check, so Phase 4's
 * original-send cap enforcement is unaffected.
 */
export async function getTodaysSendCount(referenceDate: Date = new Date()): Promise<number> {
  const start = startOfUtcDay(referenceDate);
  const end = new Date(start.getTime() + MS_PER_DAY);
  const todayRange = { gte: start, lt: end };

  return prisma.prospect.count({
    where: { OR: [{ sentAt: todayRange }, { lastFollowupAt: todayRange }] },
  });
}
