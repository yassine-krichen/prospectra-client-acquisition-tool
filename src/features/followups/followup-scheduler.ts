import { Prisma, ProspectStatus as PrismaProspectStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { getTodaysSendCount } from '@/features/sending/daily-send-counter';
import { sendEmail } from '@/features/sending/resend.client';
import { renderFollowupTemplate } from '@/features/followups/followup-templates';
import type { FollowupTouchNumber } from '@/features/followups/followup-templates';
import { signalSchema } from '@/features/prospects/prospect.types';

// Stage 4 follow-up scheduler. Reuses the exact same send mechanism as
// send-queue.service.ts (`sendEmail` from resend.client.ts) and the exact
// same daily-cap gate (`getEffectiveDailyCap()`/`getTodaysSendCount()`,
// re-checked fresh immediately before every individual send, never cached
// across the batch) - a follow-up send is still a send, so it must never be
// able to blow through the cap via a separate, weaker code path.

// Spec allows "3-5 days apart"; 4 is the midpoint, and a single fixed
// interval (rather than a per-touch schedule) keeps the eligibility check a
// one-line staleness test. Revisit if a later phase wants per-touch spacing.
export const FOLLOWUP_INTERVAL_DAYS = 4;

// "3-4 touches ... auto-dead after 4 unanswered touches" is read here as: 4
// TOTAL touches (the original send counts as touch 1), with `dead` firing
// once the 4th touch (`followup_3`) has itself gone unanswered past its own
// follow-up window - not a same-tick "send touch 4 then instantly mark
// dead". Concretely:
//   sent (touch 1 sent, followupCount 0)
//     -> stale by FOLLOWUP_INTERVAL_DAYS -> send touch 2 -> followup_1 (count 1)
//     -> stale again                      -> send touch 3 -> followup_2 (count 2)
//     -> stale again                      -> send touch 4 -> followup_3 (count 3)
//     -> stale again (touch 4 unanswered) -> no touch 5; status -> dead
export const MAX_TOTAL_TOUCHES = 4;

// Batch size per scheduler invocation. The candidate query itself is bounded
// by status + doNotContact only (Prisma can't cheaply filter on the computed
// "stale by N days from lastFollowupAt-or-sentAt" condition without raw SQL);
// staleness is filtered in memory and the result sliced to this limit before
// any send is attempted. Fine at this app's current prospect volume - revisit
// with a raw/indexed query if that stops being true.
export const FOLLOWUP_BATCH_SIZE = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const FOLLOWUP_ELIGIBLE_STATUSES = [
  PrismaProspectStatus.sent,
  PrismaProspectStatus.followup_1,
  PrismaProspectStatus.followup_2,
  PrismaProspectStatus.followup_3,
] as const;

// Maps a prospect's *current* status to the next touch it's due for and the
// status it advances to on a successful send. `followup_3` is deliberately
// absent - it has no "next touch": once stale again it goes to `dead`
// instead (handled separately in the scheduling loop below).
const TOUCH_TRANSITIONS: Partial<
  Record<PrismaProspectStatus, { touch: FollowupTouchNumber; nextStatus: PrismaProspectStatus }>
> = {
  [PrismaProspectStatus.sent]: { touch: 2, nextStatus: PrismaProspectStatus.followup_1 },
  [PrismaProspectStatus.followup_1]: { touch: 3, nextStatus: PrismaProspectStatus.followup_2 },
  [PrismaProspectStatus.followup_2]: { touch: 4, nextStatus: PrismaProspectStatus.followup_3 },
};

const PROSPECT_SELECT = {
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
} as const satisfies Prisma.ProspectSelect;

type CandidateProspect = Prisma.ProspectGetPayload<{ select: typeof PROSPECT_SELECT }>;

export type FollowupOutcome =
  | { prospectId: string; outcome: 'sent'; touch: FollowupTouchNumber }
  | { prospectId: string; outcome: 'marked_dead' }
  | { prospectId: string; outcome: 'skipped_cap' }
  | { prospectId: string; outcome: 'skipped_not_eligible' }
  | { prospectId: string; outcome: 'failed'; reason: string };

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
 * Marks a `followup_3` prospect whose window has elapsed again (touch 4 sent
 * and unanswered) as permanently `dead`. Uses the same atomic-claim pattern
 * as a send below - `updateMany` with `status: followup_3` in the `WHERE` -
 * so a reply arriving concurrently (which would have already advanced status
 * to `replied`) makes this a no-op instead of overwriting a reply.
 */
async function markDead(candidate: CandidateProspect): Promise<FollowupOutcome> {
  const statusHistory = Array.isArray(candidate.statusHistory) ? candidate.statusHistory : [];
  const now = new Date();

  const claim = await prisma.prospect.updateMany({
    where: { id: candidate.id, status: PrismaProspectStatus.followup_3, doNotContact: false },
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
async function attemptFollowupSend(
  candidate: CandidateProspect,
  touch: FollowupTouchNumber,
  nextStatus: PrismaProspectStatus
): Promise<FollowupOutcome> {
  if (!candidate.contactEmail) {
    return { prospectId: candidate.id, outcome: 'failed', reason: 'prospect has no contact email on file' };
  }

  const signalResult = signalSchema.safeParse(candidate.signal);
  if (!signalResult.success) {
    return { prospectId: candidate.id, outcome: 'failed', reason: 'prospect has no valid signal on file' };
  }

  const originalSubject = await fetchOriginalSubject(candidate.activeDraftId);
  const rendered = renderFollowupTemplate(touch, {
    companyName: candidate.companyName,
    originalSubject,
    signal: signalResult.data,
  });
  if (!rendered.ok) {
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
    return { prospectId: candidate.id, outcome: 'skipped_not_eligible' };
  }

  const sendResult = await sendEmail({
    to: candidate.contactEmail,
    subject: rendered.template.subject,
    body: rendered.template.body,
  });

  if (!sendResult.ok) {
    // Roll back the claim so a later scheduler run can legitimately retry -
    // a failed send must never permanently strand a prospect mid-sequence.
    // Conditioned on `status: nextStatus` (the status THIS call's claim just
    // set) rather than an unconditional update: if a reply landed during the
    // `sendEmail` network round-trip and reply-detection.service.ts's own
    // atomic claim already moved status to `replied`, that claim's WHERE no
    // longer matches `nextStatus`, so this rollback becomes a no-op instead
    // of silently overwriting the reply back to the pre-follow-up status.
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
 * Finds prospects due for their next follow-up touch and sends it (or marks
 * them `dead` once touch 4 has itself gone unanswered - see
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
 */
export async function runFollowupScheduler(limit: number = FOLLOWUP_BATCH_SIZE): Promise<FollowupOutcome[]> {
  const now = new Date();

  const candidates = (await prisma.prospect.findMany({
    where: { status: { in: [...FOLLOWUP_ELIGIBLE_STATUSES] }, doNotContact: false },
    select: PROSPECT_SELECT,
    orderBy: { priorityScore: 'desc' },
  })) as CandidateProspect[];

  const dueForAction = candidates.filter((candidate) => {
    const referenceDate = referenceTouchDate(candidate);
    return referenceDate !== null && isStale(referenceDate, now);
  });

  const batch = dueForAction.slice(0, limit);
  const outcomes: FollowupOutcome[] = [];
  let capReached = false;

  for (const candidate of batch) {
    if (candidate.status === PrismaProspectStatus.followup_3) {
      outcomes.push(await markDead(candidate));
      continue;
    }

    const transition = TOUCH_TRANSITIONS[candidate.status];
    if (!transition) {
      // Should be unreachable given FOLLOWUP_ELIGIBLE_STATUSES, but fail
      // closed (skip, don't guess) rather than send with an undefined touch.
      outcomes.push({ prospectId: candidate.id, outcome: 'skipped_not_eligible' });
      continue;
    }

    if (capReached) {
      outcomes.push({ prospectId: candidate.id, outcome: 'skipped_cap' });
      continue;
    }

    const sentToday = await getTodaysSendCount();
    if (sentToday >= getEffectiveDailyCap()) {
      capReached = true;
      outcomes.push({ prospectId: candidate.id, outcome: 'skipped_cap' });
      continue;
    }

    outcomes.push(await attemptFollowupSend(candidate, transition.touch, transition.nextStatus));
  }

  return outcomes;
}
