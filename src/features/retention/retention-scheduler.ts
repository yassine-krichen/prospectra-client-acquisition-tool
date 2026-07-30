import { JobCadence, JobStatus, Prisma } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { getTodaysSendCount } from '@/features/sending/daily-send-counter';
import { sendEmail } from '@/features/sending/resend.client';
import { renderRetentionTemplate } from '@/features/retention/retention-templates';
import type { RetentionTouchNumber, RetentionVariant } from '@/features/retention/retention-templates';

// Phase 8 retention scheduler. Mirrors followup-scheduler.ts file-for-file:
// the same shared daily-cap gate (`getEffectiveDailyCap()`/
// `getTodaysSendCount()`, re-checked fresh immediately before every
// individual send, never cached across the batch — a retention send is
// still a send, protecting the same sending-domain reputation as cold
// outreach/follow-ups), and the same atomic-claim-via-`updateMany` race
// safety, substituting `Job`/`Client` for `Prospect`.

// Batch size per scheduler invocation, same rationale as
// `FOLLOWUP_BATCH_SIZE`: the candidate query is bounded by
// status/cadence/doNotContact only, staleness is filtered in memory, and the
// result is sliced to this limit before any send is attempted.
export const RETENTION_BATCH_SIZE = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Day offsets from delivery for a one-off Job's first three touches (review,
// referral, check-in+upsell) — 3, 14, 30. Expressed here as the GAP since
// the previous touch (or delivery, for touch 1), since staleness is always
// measured from `lastRetentionTouchAt ?? deliveredAt`, not a cumulative
// offset from delivery. Touch 4 onward is the indefinite quarterly cadence
// (`QUARTERLY_REPEAT_DAYS`) — its first occurrence (day 90) has a 60-day gap
// from the day-30 touch; every occurrence after that repeats every 90 days.
const ONE_OFF_TOUCH_GAP_DAYS: Record<1 | 2 | 3, number> = {
  1: 3,
  2: 11, // 14 - 3
  3: 16, // 30 - 14
};

// The first quarterly touch on a one-off Job lands on day 90 (60 days after
// the day-30 touch); every quarterly touch on a recurring (`monthly`) Job
// (including its very first) is also spaced 90 days apart, starting 90 days
// from `soldAt` — a retainer never "delivers" in the terminal sense the
// first three one-off touches assume, so it only ever gets this one cadence.
const FIRST_QUARTERLY_GAP_DAYS = 60; // day 30 -> day 90, one-off Jobs only
export const QUARTERLY_REPEAT_DAYS = 90;

/** How many days must elapse since this Job's reference touch date before
 * its NEXT touch (`retentionTouchCount + 1`) is due. */
function gapDaysUntilNextTouch(cadence: string, retentionTouchCount: number): number {
  if (cadence === JobCadence.recurring) return QUARTERLY_REPEAT_DAYS;

  if (retentionTouchCount === 0) return ONE_OFF_TOUCH_GAP_DAYS[1];
  if (retentionTouchCount === 1) return ONE_OFF_TOUCH_GAP_DAYS[2];
  if (retentionTouchCount === 2) return ONE_OFF_TOUCH_GAP_DAYS[3];
  if (retentionTouchCount === 3) return FIRST_QUARTERLY_GAP_DAYS;
  return QUARTERLY_REPEAT_DAYS;
}

/** Which named touch kind (see retention-templates.ts) a Job's NEXT touch
 * is. A recurring Job's every touch is `4` (quarterly) — it never gets the
 * one-off-only review/referral/check-in-30 touches. */
function nextTouchNumber(cadence: string, retentionTouchCount: number): RetentionTouchNumber {
  if (cadence === JobCadence.recurring) return 4;
  if (retentionTouchCount === 0) return 1;
  if (retentionTouchCount === 1) return 2;
  if (retentionTouchCount === 2) return 3;
  return 4;
}

const JOB_SELECT = {
  id: true,
  clientId: true,
  cadence: true,
  status: true,
  soldAt: true,
  deliveredAt: true,
  lastRetentionTouchAt: true,
  retentionTouchCount: true,
  statusHistory: true,
  client: { select: { companyName: true, contactEmail: true, doNotContact: true } },
} as const satisfies Prisma.JobSelect;

type CandidateJob = Prisma.JobGetPayload<{ select: typeof JOB_SELECT }>;

export type RetentionOutcome =
  | { jobId: string; outcome: 'sent'; touchNumber: RetentionTouchNumber }
  | { jobId: string; outcome: 'skipped_cap' }
  | { jobId: string; outcome: 'skipped_not_eligible' }
  | { jobId: string; outcome: 'failed'; reason: string };

function isStale(referenceDate: Date, now: Date, gapDays: number): boolean {
  return now.getTime() - referenceDate.getTime() >= gapDays * MS_PER_DAY;
}

/** `lastRetentionTouchAt` if a touch has already gone out, else the Job's
 * natural starting point: `deliveredAt` for a one-off Job, `soldAt` for a
 * recurring one. `null` means this candidate isn't actually in a touchable
 * state yet (e.g. a one-off `delivered` Job somehow missing `deliveredAt`)
 * — the caller skips it rather than guessing a reference point. */
function referenceTouchDate(candidate: CandidateJob): Date | null {
  if (candidate.cadence === JobCadence.recurring) {
    return candidate.lastRetentionTouchAt ?? candidate.soldAt;
  }
  return candidate.lastRetentionTouchAt ?? candidate.deliveredAt;
}

/**
 * Day-30-or-later touches (`checkin_30`/`quarterly`) suppress the upsell ask
 * when a sibling `monthly` Job already exists on the same Client — no point
 * pitching a retainer this Client already bought. Day-3/day-14 touches
 * (review/referral) never check this and always render `checkin_only`
 * (unused by those two templates in any case).
 */
async function resolveVariant(
  candidate: CandidateJob,
  touchNumber: RetentionTouchNumber
): Promise<RetentionVariant> {
  if (touchNumber < 3) return 'checkin_only';

  const siblingMonthlyJob = await prisma.job.findFirst({
    where: { clientId: candidate.clientId, status: JobStatus.monthly, id: { not: candidate.id } },
    select: { id: true },
  });

  return siblingMonthlyJob ? 'checkin_only' : 'with_upsell';
}

/**
 * Attempts one retention touch for a candidate already confirmed stale and
 * eligible for `touchNumber`/`variant`. The atomic claim below closes the
 * same race followup-scheduler.ts's `attemptFollowupSend` closes, adapted to
 * the fact that a retention touch — unlike a follow-up — never changes
 * `Job.status`: there is no "next status" to use as the optimistic-lock key,
 * so the claim's WHERE instead pins `lastRetentionTouchAt` and
 * `retentionTouchCount` to the exact values just read, on top of `status`
 * and `client.doNotContact`. If a concurrent scheduler run (or a status
 * change, e.g. the Job getting cancelled) has already moved any of those
 * since this candidate was read, the claim matches zero rows and this
 * function aborts without ever calling `sendEmail`.
 */
async function attemptRetentionSend(
  candidate: CandidateJob,
  touchNumber: RetentionTouchNumber,
  variant: RetentionVariant
): Promise<RetentionOutcome> {
  if (!candidate.client.contactEmail) {
    return { jobId: candidate.id, outcome: 'failed', reason: 'client has no contact email on file' };
  }

  const rendered = renderRetentionTemplate(touchNumber, { companyName: candidate.client.companyName, variant });
  if (!rendered.ok) {
    return { jobId: candidate.id, outcome: 'failed', reason: rendered.reasons.join('; ') };
  }

  const statusHistory = Array.isArray(candidate.statusHistory) ? candidate.statusHistory : [];
  const now = new Date();
  const priorLastRetentionTouchAt = candidate.lastRetentionTouchAt;
  const priorRetentionTouchCount = candidate.retentionTouchCount;

  const claim = await prisma.job.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      lastRetentionTouchAt: priorLastRetentionTouchAt,
      retentionTouchCount: priorRetentionTouchCount,
      client: { doNotContact: false },
    },
    data: {
      lastRetentionTouchAt: now,
      retentionTouchCount: { increment: 1 },
      statusHistory: [...statusHistory, { status: `retention_touch_${touchNumber}`, timestamp: now.toISOString() }],
    },
  });

  if (claim.count !== 1) {
    // Lost the race: doNotContact flipped true, the Job's status changed
    // concurrently, or a concurrent scheduler run already claimed this exact
    // touch. Fail closed — never send.
    return { jobId: candidate.id, outcome: 'skipped_not_eligible' };
  }

  const sendResult = await sendEmail({
    to: candidate.client.contactEmail,
    subject: rendered.template.subject,
    body: rendered.template.body,
  });

  if (!sendResult.ok) {
    // Roll back the claim so a later scheduler run can legitimately retry —
    // a failed send must never permanently strand a Job mid-sequence.
    // Conditioned on `lastRetentionTouchAt`/`retentionTouchCount` equalling
    // the exact values THIS call's claim just set (rather than an
    // unconditional update), mirroring attemptFollowupSend's rollback
    // fingerprint — just keyed to these fields instead of `status`, since a
    // retention touch never changes `status`.
    await prisma.job.updateMany({
      where: { id: candidate.id, lastRetentionTouchAt: now, retentionTouchCount: priorRetentionTouchCount + 1 },
      data: {
        lastRetentionTouchAt: priorLastRetentionTouchAt,
        retentionTouchCount: priorRetentionTouchCount,
        statusHistory,
      },
    });
    return { jobId: candidate.id, outcome: 'failed', reason: sendResult.reason };
  }

  return { jobId: candidate.id, outcome: 'sent', touchNumber };
}

/**
 * Finds Jobs due for their next retention touch and sends it. Eligibility:
 *
 *   - a one-off Job with `status: 'delivered'`, or a recurring Job with
 *     `status: 'monthly'`
 *   - its Client's `doNotContact` is `false`
 *   - stale by the touch's gap (see `gapDaysUntilNextTouch`) from
 *     `lastRetentionTouchAt` (or the Job's natural starting point if no
 *     touch has gone out yet — see `referenceTouchDate`)
 *
 * The daily send cap (`getEffectiveDailyCap()`/`getTodaysSendCount()`) is
 * re-checked fresh immediately before each send attempt, exactly like
 * followup-scheduler.ts — once the cap is hit, every remaining due Job in
 * this batch is reported `skipped_cap` without an atomic claim ever being
 * attempted for it.
 */
export async function runRetentionScheduler(limit: number = RETENTION_BATCH_SIZE): Promise<RetentionOutcome[]> {
  const now = new Date();

  const candidates = (await prisma.job.findMany({
    where: {
      OR: [
        { cadence: JobCadence.one_off, status: JobStatus.delivered },
        { cadence: JobCadence.recurring, status: JobStatus.monthly },
      ],
      client: { doNotContact: false },
    },
    select: JOB_SELECT,
    orderBy: { createdAt: 'asc' },
  })) as CandidateJob[];

  const dueForAction: Array<{ candidate: CandidateJob; touchNumber: RetentionTouchNumber }> = [];
  for (const candidate of candidates) {
    const referenceDate = referenceTouchDate(candidate);
    if (referenceDate === null) continue;

    const gapDays = gapDaysUntilNextTouch(candidate.cadence, candidate.retentionTouchCount);
    if (isStale(referenceDate, now, gapDays)) {
      dueForAction.push({ candidate, touchNumber: nextTouchNumber(candidate.cadence, candidate.retentionTouchCount) });
    }
  }

  const batch = dueForAction.slice(0, limit);
  const outcomes: RetentionOutcome[] = [];
  let capReached = false;

  for (const { candidate, touchNumber } of batch) {
    if (capReached) {
      outcomes.push({ jobId: candidate.id, outcome: 'skipped_cap' });
      continue;
    }

    const sentToday = await getTodaysSendCount();
    if (sentToday >= getEffectiveDailyCap()) {
      capReached = true;
      outcomes.push({ jobId: candidate.id, outcome: 'skipped_cap' });
      continue;
    }

    const variant = await resolveVariant(candidate, touchNumber);
    outcomes.push(await attemptRetentionSend(candidate, touchNumber, variant));
  }

  return outcomes;
}
