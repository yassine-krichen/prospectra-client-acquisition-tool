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
 * rather than a separate counter table - per the Phase 4 spec, counting
 * existing timestamp columns avoids introducing a second source of truth
 * that could drift out of sync with what was actually sent. This is the
 * only place send-queue.service.ts, followup-scheduler.ts, and
 * retention-scheduler.ts ask "how many have gone out today", and it's
 * re-queried before every individual send in a batch (not cached), so a
 * bulk-approve, follow-up run, or retention run can't blow through the
 * shared daily cap mid-batch.
 *
 * `sentAt` is set once, by the original send (send-queue.service.ts), and
 * must keep meaning exactly that - it is never overwritten by a follow-up.
 * `lastFollowupAt` is set on every subsequent follow-up touch
 * (followup-scheduler.ts). `lastRetentionTouchAt` is set on every retention
 * touch (retention-scheduler.ts) - a Job, not a Prospect, so it's a separate
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

function currentUtcDateString(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
}

/**
 * Atomically reserves one unit of today's daily send cap, shared across
 * `send-queue.service.ts`, `followup-scheduler.ts`, and
 * `retention-scheduler.ts` - every code path that can cause an email to go
 * out. Returns `false` (reserve nothing) once `cap` has already been
 * reserved today.
 *
 * This exists alongside (not instead of) `getTodaysSendCount()` above
 * specifically to close a real race that function's own doc comment
 * doesn't cover: two concurrent callers (two browser tabs, or a manual
 * dashboard trigger racing the daily cron) can each independently read
 * `getTodaysSendCount()` just under the cap, both decide there's room, and
 * both proceed - since each is claiming a *different* Draft/Prospect/Job
 * row, `send-queue.service.ts`'s own per-draft atomic claim doesn't catch
 * this, and neither would a bare `count() < cap` check no matter which
 * table it reads from. This function fixes that the same way
 * `reserveHunterQuota` in hunter.source.ts already does: `count: { lt: cap
 * }` is evaluated by Postgres as part of the UPDATE itself, and - critically
 * - every concurrent caller is updating the *same* counter row (keyed by
 * today's date), so Postgres's own row-level locking serializes them,
 * which two independent reads against different rows never could.
 *
 * Callers must call `rollBackDailySendSlot()` if the reserved slot doesn't
 * end up corresponding to a real send (the `sendEmail` call itself fails) -
 * see the doc comment there.
 */
export async function reserveDailySendSlot(cap: number): Promise<boolean> {
  const date = currentUtcDateString();

  // `createMany` + `skipDuplicates`, NOT `upsert` - verified live under a
  // real concurrent-burst test (20 simultaneous callers for the same
  // `date`): `upsert` is create-then-update under the hood, and a genuine
  // burst of concurrent callers can have more than one attempt the create
  // half at once, so the loser gets a raw unique-constraint
  // `PrismaClientKnownRequestError` instead of transparently falling back
  // to the update - `upsert` is not itself safe against concurrent bursts
  // racing on the same key. `createMany` with `skipDuplicates` is: Postgres
  // handles the conflict as part of the INSERT statement itself (`ON
  // CONFLICT DO NOTHING`), so concurrent callers just insert 0 or 1 rows
  // between them, never throw.
  await prisma.dailySendCounter.createMany({
    data: [{ date, count: 0 }],
    skipDuplicates: true,
  });

  const reserved = await prisma.dailySendCounter.updateMany({
    where: { date, count: { lt: cap } },
    data: { count: { increment: 1 } },
  });

  return reserved.count > 0;
}

/**
 * Compensating rollback for a reserved daily-send-cap slot - call this
 * whenever a slot was reserved via `reserveDailySendSlot` but the send it
 * was reserved for did not actually happen (the `sendEmail` call failed, or
 * the per-row atomic claim immediately after reserving lost its own race -
 * e.g. a reply arrived, or `doNotContact` flipped true, in the interim).
 * Never call this after a real send succeeded - `getTodaysSendCount()`'s
 * own timestamp-derived count already reflects that send, and this counter
 * is only ever consulted for the reservation decision, never displayed, so
 * it must track "how many sends are reserved/in-flight-or-done today", not
 * "how many actually landed".
 */
export async function rollBackDailySendSlot(): Promise<void> {
  const date = currentUtcDateString();

  await prisma.dailySendCounter.updateMany({
    where: { date, count: { gt: 0 } },
    data: { count: { decrement: 1 } },
  });
}
