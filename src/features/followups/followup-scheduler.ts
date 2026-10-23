import { Prisma, ProspectStatus as PrismaProspectStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { reserveDailySendSlot, rollBackDailySendSlot } from '@/features/sending/daily-send-counter';
import { sendEmail } from '@/features/sending/resend.client';
import { isFollowupApprovalRequired } from '@/features/followups/followup-approval-setting';
import { renderFollowupTemplate } from '@/features/followups/followup-templates';
import type { FollowupTouchNumber } from '@/features/followups/followup-templates';
import { signalSchema } from '@/features/prospects/prospect.types';

// Stage 4 follow-up scheduler. Reuses the exact same send mechanism as
// send-queue.service.ts (`sendEmail` from resend.client.ts) and the exact
// same daily-cap gate (`getEffectiveDailyCap()`/`reserveDailySendSlot()`,
// re-reserved fresh immediately before every individual send, never cached
// across the batch) - a follow-up send is still a send, so it must never be
// able to blow through the cap via a separate, weaker code path.

// Spec allows "3-5 days apart"; 4 is the midpoint, and a single fixed
// interval (rather than a per-touch schedule) keeps the eligibility check a
// one-line staleness test. Revisit if a later phase wants per-touch spacing.
export const FOLLOWUP_INTERVAL_DAYS = 4;

// Cold-outreach data (6,337 emails, r/PublicRelations): one email ~4.1%
// replies, plus one follow-up a few days later ~6.6%, a second follow-up only
// ~6.9%, anything past that irritates recipients. So: 2 TOTAL touches (the
// original counts as touch 1) - one follow-up, then `dead` once that
// follow-up has itself gone unanswered for a full interval.
//   sent (touch 1 sent, followupCount 0)
//     -> stale by FOLLOWUP_INTERVAL_DAYS -> send touch 2 -> followup_1 (count 1)
//     -> stale again (touch 2 unanswered) -> no touch 3; status -> dead
// `followup_2`/`followup_3` stay in the enum and are still swept to `dead`
// here so prospects already in those states under the old 4-touch cycle
// aren't stranded.
export const MAX_TOTAL_TOUCHES = 2;

// Batch size per scheduler invocation. The candidate query itself is bounded
// by status + doNotContact only (Prisma can't cheaply filter on the computed
// "stale by N days from lastFollowupAt-or-sentAt" condition without raw SQL);
// staleness is filtered in memory and the result sliced to this limit before
// any send is attempted. Fine at this app's current prospect volume - revisit
// with a raw/indexed query if that stops being true.
export const FOLLOWUP_BATCH_SIZE = 20;

// Added to a prospect whose follow-up send failed ambiguously and so was
// deliberately not rolled back or retried; an operator should confirm in the
// provider dashboard whether touch 2 actually went out.
export const FOLLOWUP_SEND_UNCONFIRMED_TAG = 'followup-send-unconfirmed';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const FOLLOWUP_ELIGIBLE_STATUSES = [
  PrismaProspectStatus.sent,
  PrismaProspectStatus.followup_1,
  PrismaProspectStatus.followup_2,
  PrismaProspectStatus.followup_3,
] as const;

// The only send this scheduler makes: a `sent` prospect gets touch 2 and
// advances to `followup_1`. Every `followup_*` status has no next touch -
// once stale again it goes to `dead` instead (see the scheduling loop).
export const SECOND_TOUCH: { touch: FollowupTouchNumber; nextStatus: PrismaProspectStatus } = {
  touch: 2,
  nextStatus: PrismaProspectStatus.followup_1,
};

export const FOLLOWUP_CANDIDATE_SELECT = {
  id: true,
  companyName: true,
  contactEmail: true,
  doNotContact: true,
  status: true,
  followupCount: true,
  lastFollowupAt: true,
  sentAt: true,
  signal: true,
  statusHistory: true,
  activeDraftId: true,
  priorityScore: true,
  tags: true,
} as const satisfies Prisma.ProspectSelect;

export type CandidateProspect = Prisma.ProspectGetPayload<{ select: typeof FOLLOWUP_CANDIDATE_SELECT }>;

export type FollowupOutcome =
  | { prospectId: string; outcome: 'sent'; touch: FollowupTouchNumber }
  | { prospectId: string; outcome: 'marked_dead' }
  | { prospectId: string; outcome: 'skipped_cap' }
  | { prospectId: string; outcome: 'skipped_not_eligible' }
  // Approval mode only: a stale `sent` prospect whose follow-up is waiting
  // for a human on the Queue page. Nothing was claimed, reserved or sent.
  | { prospectId: string; outcome: 'awaiting_approval' }
  | { prospectId: string; outcome: 'failed'; reason: string };

/** The outcomes a single send attempt can produce - what the approval
 * service reports per prospect. */
export type FollowupSendOutcome = Extract<
  FollowupOutcome,
  { outcome: 'sent' | 'failed' | 'skipped_cap' | 'skipped_not_eligible' }
>;

function isStale(lastTouchAt: Date, referenceDate: Date): boolean {
  return referenceDate.getTime() - lastTouchAt.getTime() >= FOLLOWUP_INTERVAL_DAYS * MS_PER_DAY;
}

/** `lastFollowupAt` if a follow-up has already gone out, else `sentAt` (the
 * original send) - the reference point every staleness check is measured
 * from. `null` (neither field set) means this prospect isn't actually in a
 * followable state yet; the caller skips it. */
function referenceTouchDate(candidate: CandidateProspect): Date | null {
  return candidate.lastFollowupAt ?? candidate.sentAt;
}

async function fetchOriginalSubject(activeDraftId: string | null): Promise<string | null> {
  if (!activeDraftId) return null;
  const draft = await prisma.draft.findUnique({ where: { id: activeDraftId }, select: { subject: true } });
  return draft?.subject ?? null;
}

/**
 * Marks a `followup_*` prospect whose window has elapsed again (its last
 * touch sent and unanswered) as permanently `dead`. Uses the same atomic-claim pattern
 * as a send below - `updateMany` with `status: candidate.status` in the `WHERE` -
 * so a reply arriving concurrently (which would have already advanced status
 * to `replied`) makes this a no-op instead of overwriting a reply.
 */
async function markDead(candidate: CandidateProspect): Promise<FollowupOutcome> {
  const statusHistory = Array.isArray(candidate.statusHistory) ? candidate.statusHistory : [];
  const now = new Date();

  const claim = await prisma.prospect.updateMany({
    where: { id: candidate.id, status: candidate.status, doNotContact: false },
    data: {
      status: PrismaProspectStatus.dead,
      statusHistory: [...statusHistory, { status: PrismaProspectStatus.dead, timestamp: now.toISOString() }],
    },
  });

  if (claim.count !== 1) {
    return { prospectId: candidate.id, outcome: 'skipped_not_eligible' };
  }
  return { prospectId: candidate.id, outcome: 'marked_dead' };
}

/**
 * Attempts one follow-up send for a candidate already confirmed stale and
 * eligible for `touch`/`nextStatus`. The atomic claim below - a single
 * `updateMany` conditioned on `status` still equalling the exact status this
 * candidate was read at, plus `doNotContact: false` - is what actually closes
 * the reply-vs-follow-up race: if a reply webhook has already advanced this
 * prospect's status to `replied` (or flipped `doNotContact`) since this
 * candidate was read, the claim matches zero rows and this function aborts
 * without ever calling `sendEmail`. This mirrors send-queue.service.ts's
 * `Draft.approved` claim exactly, just against `Prospect.status` instead of
 * `Draft.approved`.
 */
export async function attemptFollowupSend(
  candidate: CandidateProspect,
  touch: FollowupTouchNumber,
  nextStatus: PrismaProspectStatus
): Promise<FollowupSendOutcome> {
  if (!candidate.contactEmail) {
    await rollBackDailySendSlot();
    return { prospectId: candidate.id, outcome: 'failed', reason: 'prospect has no contact email on file' };
  }

  const signalResult = signalSchema.safeParse(candidate.signal);
  if (!signalResult.success) {
    await rollBackDailySendSlot();
    return { prospectId: candidate.id, outcome: 'failed', reason: 'prospect has no valid signal on file' };
  }

  const originalSubject = await fetchOriginalSubject(candidate.activeDraftId);
  const rendered = renderFollowupTemplate(touch, {
    companyName: candidate.companyName,
    originalSubject,
    signal: signalResult.data,
  });
  if (!rendered.ok) {
    await rollBackDailySendSlot();
    return { prospectId: candidate.id, outcome: 'failed', reason: rendered.reasons.join('; ') };
  }

  const statusHistory = Array.isArray(candidate.statusHistory) ? candidate.statusHistory : [];
  const now = new Date();

  const claim = await prisma.prospect.updateMany({
    where: { id: candidate.id, status: candidate.status, doNotContact: false },
    data: {
      status: nextStatus,
      lastFollowupAt: now,
      followupCount: candidate.followupCount + 1,
      statusHistory: [...statusHistory, { status: nextStatus, timestamp: now.toISOString() }],
    },
  });

  if (claim.count !== 1) {
    // Lost the race: a reply arrived (status is no longer what we read it
    // as), doNotContact flipped true, or a concurrent scheduler run already
    // claimed this prospect. Fail closed - never send.
    await rollBackDailySendSlot();
    return { prospectId: candidate.id, outcome: 'skipped_not_eligible' };
  }

  const sendResult = await sendEmail({
    to: candidate.contactEmail,
    subject: rendered.template.subject,
    body: rendered.template.body,
  });

  if (!sendResult.ok && !sendResult.definitelyNotSent) {
    // Ambiguous failure (timeout, 5xx, unparseable response): the provider
    // may have delivered. Rolling back would let the next run send touch 2
    // again, breaking the never-send-twice invariant, so the claim stays
    // (status is already followup_1, which is never re-sent) and the
    // prospect is tagged so an operator can check the provider dashboard.
    try {
      await prisma.prospect.updateMany({
        where: { id: candidate.id, status: nextStatus },
        data: { tags: { push: FOLLOWUP_SEND_UNCONFIRMED_TAG } },
      });
    } catch (error) {
      console.error(`failed to tag prospect ${candidate.id} as ${FOLLOWUP_SEND_UNCONFIRMED_TAG}`, error);
    }
    return {
      prospectId: candidate.id,
      outcome: 'failed',
      reason: `send outcome unconfirmed, not retried: ${sendResult.reason}`,
    };
  }

  if (!sendResult.ok) {
    // Definite non-delivery (see `definitelyNotSent`): roll back the claim so
    // a later scheduler run can legitimately retry - a rejected send must
    // never permanently strand a prospect mid-sequence.
    // Conditioned on `status: nextStatus` (the status THIS call's claim just
    // set) rather than an unconditional update: if a reply landed during the
    // `sendEmail` network round-trip and reply-detection.service.ts's own
    // atomic claim already moved status to `replied`, that claim's WHERE no
    // longer matches `nextStatus`, so this rollback becomes a no-op instead
    // of silently overwriting the reply back to the pre-follow-up status.
    // The reserved daily-send-cap slot is rolled back too.
    await rollBackDailySendSlot();
    await prisma.prospect.updateMany({
      where: { id: candidate.id, status: nextStatus },
      data: {
        status: candidate.status,
        lastFollowupAt: candidate.lastFollowupAt,
        followupCount: candidate.followupCount,
        statusHistory,
      },
    });
    return { prospectId: candidate.id, outcome: 'failed', reason: sendResult.reason };
  }

  return { prospectId: candidate.id, outcome: 'sent', touch };
}

/**
 * Every prospect currently due for follow-up action, highest `priorityScore`
 * first: in-flight status, `doNotContact: false`, and stale by
 * `FOLLOWUP_INTERVAL_DAYS` from `lastFollowupAt` (or `sentAt` if no
 * follow-up has gone out yet). Shared by the scheduler and the approval
 * queue so both always agree on what "due" means.
 */
export async function findDueFollowupCandidates(now: Date = new Date()): Promise<CandidateProspect[]> {
  const candidates = (await prisma.prospect.findMany({
    where: { status: { in: [...FOLLOWUP_ELIGIBLE_STATUSES] }, doNotContact: false },
    select: FOLLOWUP_CANDIDATE_SELECT,
    orderBy: { priorityScore: 'desc' },
  })) as CandidateProspect[];

  return candidates.filter((candidate) => {
    const referenceDate = referenceTouchDate(candidate);
    return referenceDate !== null && isStale(referenceDate, now);
  });
}

/** Whether `candidate` is, right now, a stale `sent` prospect eligible for the
 * second touch. The approval service re-checks this against a fresh read. */
export function isDueForSecondTouch(candidate: CandidateProspect, now: Date = new Date()): boolean {
  const referenceDate = referenceTouchDate(candidate);
  return (
    candidate.status === PrismaProspectStatus.sent &&
    !candidate.doNotContact &&
    referenceDate !== null &&
    isStale(referenceDate, now)
  );
}

/**
 * Finds prospects due for their next follow-up touch and sends it (or marks
 * them `dead` once the last touch has itself gone unanswered - see
 * `MAX_TOTAL_TOUCHES`'s doc comment). Eligibility:
 *
 *   - `status` in `sent`/`followup_1`/`followup_2`/`followup_3`
 *   - `doNotContact` is `false`
 *   - stale by `FOLLOWUP_INTERVAL_DAYS` from `lastFollowupAt` (or `sentAt` if
 *     no follow-up has gone out yet)
 *
 * The daily send cap (`getEffectiveDailyCap()`/`getTodaysSendCount()`) is
 * re-checked fresh immediately before each send attempt, exactly like
 * send-queue.service.ts's `approveDrafts` - once the cap is hit, every
 * remaining eligible prospect in this batch is reported `skipped_cap`
 * without an atomic claim ever being attempted for it.
 *
 * When follow-up approval is required (the default - see
 * followup-approval-setting.ts) this function never sends: stale `sent`
 * prospects are reported `awaiting_approval` and left untouched for a human
 * to approve via followup-approval.service.ts. They are removed BEFORE the
 * batch slice, otherwise a backlog of awaiting prospects (which can never
 * be completed here) would fill the batch and starve the dead-sweep behind
 * them. The dead-sweep itself needs no approval and runs either way.
 */
export async function runFollowupScheduler(limit: number = FOLLOWUP_BATCH_SIZE): Promise<FollowupOutcome[]> {
  const dueForAction = await findDueFollowupCandidates(new Date());
  const approvalRequired = isFollowupApprovalRequired();

  const awaitingApproval = approvalRequired
    ? dueForAction.filter((candidate) => candidate.status === PrismaProspectStatus.sent)
    : [];
  const actionable = approvalRequired
    ? dueForAction.filter((candidate) => candidate.status !== PrismaProspectStatus.sent)
    : dueForAction;

  const batch = actionable.slice(0, limit);
  const outcomes: FollowupOutcome[] = [];
  let capReached = false;

  for (const candidate of batch) {
    if (candidate.status !== PrismaProspectStatus.sent) {
      outcomes.push(await markDead(candidate));
      continue;
    }

    if (capReached) {
      outcomes.push({ prospectId: candidate.id, outcome: 'skipped_cap' });
      continue;
    }

    // Atomically reserves a slot against the shared daily cap - see the doc
    // comment on `reserveDailySendSlot` in daily-send-counter.ts.
    // `attemptFollowupSend` rolls this back on every path that doesn't end
    // in a real send.
    if (!(await reserveDailySendSlot(getEffectiveDailyCap()))) {
      capReached = true;
      outcomes.push({ prospectId: candidate.id, outcome: 'skipped_cap' });
      continue;
    }

    outcomes.push(await attemptFollowupSend(candidate, SECOND_TOUCH.touch, SECOND_TOUCH.nextStatus));
  }

  for (const candidate of awaitingApproval) {
    outcomes.push({ prospectId: candidate.id, outcome: 'awaiting_approval' });
  }

  return outcomes;
}
