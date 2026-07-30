import { prisma } from '@/common/db/client';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Midnight UTC for the given date's calendar day. UTC (not local time) so
// the boundary is deterministic regardless of server/deployment timezone.
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Server-enforced count of emails actually sent today (UTC), derived from
 * `Prospect.sentAt`/`Prospect.lastFollowupAt`/`Job.lastRetentionTouchAt`
 * rather than a separate counter table — per the Phase 4 spec, counting
 * existing timestamp columns avoids introducing a second source of truth
 * that could drift out of sync with what was actually sent. This is the
 * only place send-queue.service.ts, followup-scheduler.ts, and
 * retention-scheduler.ts ask "how many have gone out today", and it's
 * re-queried before every individual send in a batch (not cached), so a
 * bulk-approve, follow-up run, or retention run can't blow through the
 * shared daily cap mid-batch.
 *
 * `sentAt` is set once, by the original send (send-queue.service.ts), and
 * must keep meaning exactly that — it is never overwritten by a follow-up.
 * `lastFollowupAt` is set on every subsequent follow-up touch
 * (followup-scheduler.ts). `lastRetentionTouchAt` is set on every retention
 * touch (retention-scheduler.ts) — a Job, not a Prospect, so it's a separate
 * count summed in, not a third OR branch on the same table. A follow-up or
 * retention send is still a send against the same sending-domain reputation,
 * so it counts toward today's total alongside original sends.
 */
export async function getTodaysSendCount(referenceDate: Date = new Date()): Promise<number> {
  const start = startOfUtcDay(referenceDate);
  const end = new Date(start.getTime() + MS_PER_DAY);
  const todayRange = { gte: start, lt: end };

  const [prospectCount, retentionTouchCount] = await Promise.all([
    prisma.prospect.count({
      where: { OR: [{ sentAt: todayRange }, { lastFollowupAt: todayRange }] },
    }),
    prisma.job.count({ where: { lastRetentionTouchAt: todayRange } }),
  ]);

  return prospectCount + retentionTouchCount;
}
