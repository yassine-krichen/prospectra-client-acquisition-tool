import { Prisma, ProspectStatus as PrismaProspectStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { reserveDailySendSlot, rollBackDailySendSlot } from '@/features/sending/daily-send-counter';
import { sendEmail } from '@/features/sending/resend.client';
import type { ApprovalOutcome, ApprovalRequestItem } from '@/features/sending/sending.types';

// This module is the one place in the codebase where a code path can
// actually cause an email to leave the system. The core safety invariant
// carried through every earlier phase - "no code path may send an email
// without a human clicking approve first" - means `approveDrafts` below is
// the ONLY function that may call `sendEmail`, and it is only ever reached
// via a human-initiated approval request (the /api/queue/approve route).

const DRAFT_SELECT = {
  id: true,
  prospectId: true,
  subject: true,
  body: true,
  humanizedBody: true,
  approved: true,
  prospect: {
    select: {
      id: true,
      doNotContact: true,
      priorityScore: true,
      contactEmail: true,
      statusHistory: true,
    },
  },
} as const satisfies Prisma.DraftSelect;

type DraftWithProspect = Prisma.DraftGetPayload<{ select: typeof DRAFT_SELECT }>;

/**
 * Approves and attempts to send one or more drafts. For each requested
 * item, in `priorityScore`-descending order across the whole batch (not
 * request order):
 *
 *   1. Refuses (fails closed) if the draft doesn't exist, was already
 *      approved (see the atomic claim in step 4 - this also covers a
 *      draft named more than once in the same batch), or its prospect has
 *      `doNotContact: true` - never sent, no matter what a bulk-approve
 *      request asked for.
 *   2. Atomically reserves a slot against the effective daily cap
 *      (`getEffectiveDailyCap()`, via `reserveDailySendSlot` in
 *      daily-send-counter.ts) immediately before every send - not once at
 *      batch start, and not a plain `getTodaysSendCount() >= cap` read -
 *      so neither a bulk-approve batch nor a *concurrent* one (another tab,
 *      or the daily cron) can blow through the cap between them. Once the
 *      cap is hit, every remaining item in the batch is reported
 *      `skipped_cap` without attempting to send. Every exit path after a
 *      successful reservation that doesn't end in a real send
 *      (`rollBackDailySendSlot`) gives the slot back.
 *   3. Refuses if the prospect has no `contactEmail` on file (checked once
 *      from the batch snapshot, then re-checked fresh in step 4).
 *   4. Immediately before sending, atomically claims the draft with a
 *      single conditional update - `UPDATE ... WHERE id = ? AND approved =
 *      false` - that also applies any human edit (`editedBody`) to
 *      `Draft.body` (`edited: true`). Only the caller whose update actually
 *      matches a row (`count === 1`) proceeds to send; this is the one
 *      real guard against two concurrent approvals (two tabs, a
 *      double-click, a network retry, or a duplicate `draftId` within the
 *      same request) both reaching `sendEmail` for the same draft. Anyone
 *      who loses the claim is reported `skipped_already_approved` and
 *      never calls `sendEmail`. The edit is applied as part of this same
 *      atomic update, so it can never land on a draft that's concurrently
 *      being (or already was) sent.
 *   5. Sends via Resend. On success, advances the prospect to `sent`
 *      (`sentAt`, `statusHistory`, `activeDraftId`) - the claim from step 4
 *      already persisted `Draft.approved = true`, so a crash between the
 *      send succeeding and this step can never cause a resend, only a
 *      (recoverable) prospect-status lag. On failure, the claim is rolled
 *      back (`Draft.approved` reset to `false`) so a legitimate retry can
 *      re-approve the same draft, while the edited body is kept regardless
 *      of send outcome so a human's edit is never lost.
 *
 * Returns one outcome per requested item, in the same order the items were
 * requested in (regardless of the priority order they were processed in).
 */
export async function approveDrafts(items: ApprovalRequestItem[]): Promise<ApprovalOutcome[]> {
  if (items.length === 0) return [];

  const draftIds = items.map((item) => item.draftId);
  const drafts = await prisma.draft.findMany({
    where: { id: { in: draftIds } },
    select: DRAFT_SELECT,
  });
  const draftById = new Map<string, DraftWithProspect>(drafts.map((draft) => [draft.id, draft]));

  // Highest prospect priorityScore first. Requested items whose draft
  // doesn't exist sort last (they're reported `not_found` and never
  // compete for cap headroom against real candidates).
  const ordered = [...items].sort((a, b) => {
    const scoreA = draftById.get(a.draftId)?.prospect.priorityScore ?? Number.NEGATIVE_INFINITY;
    const scoreB = draftById.get(b.draftId)?.prospect.priorityScore ?? Number.NEGATIVE_INFINITY;
    return scoreB - scoreA;
  });

  const outcomeByDraftId = new Map<string, ApprovalOutcome>();
  let capReached = false;

  for (const item of ordered) {
    const draft = draftById.get(item.draftId);

    if (!draft) {
      outcomeByDraftId.set(item.draftId, { draftId: item.draftId, outcome: 'not_found' });
      continue;
    }

    // A draft already approved before this batch even started (e.g. a
    // prior request, or an earlier row in this same result set) - fail
    // closed without ever touching the cap or doNotContact logic below.
    // The narrower race (approved concurrently between this read and this
    // item's send attempt) is caught by the atomic claim further down.
    if (draft.approved) {
      outcomeByDraftId.set(item.draftId, { draftId: item.draftId, outcome: 'skipped_already_approved' });
      continue;
    }

    if (capReached) {
      outcomeByDraftId.set(item.draftId, { draftId: item.draftId, outcome: 'skipped_cap' });
      continue;
    }

    // Fail closed: doNotContact always wins over an approval request.
    if (draft.prospect.doNotContact) {
      outcomeByDraftId.set(item.draftId, { draftId: item.draftId, outcome: 'skipped_do_not_contact' });
      continue;
    }

    // Atomically reserves a slot against the shared daily cap - see the doc
    // comment on `reserveDailySendSlot` for why this (not a plain
    // `getTodaysSendCount() >= cap` read) is what actually closes the race
    // between this batch and a concurrent one (another tab, or the daily
    // cron). Every exit path below this point that doesn't end in a real
    // send must call `rollBackDailySendSlot()`.
    if (!(await reserveDailySendSlot(getEffectiveDailyCap()))) {
      capReached = true;
      outcomeByDraftId.set(item.draftId, { draftId: item.draftId, outcome: 'skipped_cap' });
      continue;
    }

    if (!draft.prospect.contactEmail) {
      await rollBackDailySendSlot();
      outcomeByDraftId.set(item.draftId, {
        draftId: item.draftId,
        outcome: 'failed',
        reason: 'prospect has no contact email on file',
      });
      continue;
    }

    // The one real concurrency guard: a single conditional update that only
    // matches (and only sends) if the draft is *still* unapproved at the
    // instant this statement runs, and - in the same atomic statement -
    // re-checks doNotContact hasn't flipped true since our initial read
    // (matching the cap's "re-check immediately before sending" standard).
    // Any human edit is applied in this same statement so it can never land
    // on a draft that's concurrently being sent elsewhere.
    const claimData: Prisma.DraftUpdateManyMutationInput = { approved: true };
    if (item.editedBody !== undefined) {
      claimData.body = item.editedBody;
      claimData.edited = true;
    }

    const claim = await prisma.draft.updateMany({
      where: { id: draft.id, approved: false, prospect: { doNotContact: false } },
      data: claimData,
    });

    if (claim.count !== 1) {
      // Something changed since our initial read: the draft was already
      // approved (a concurrent/overlapping request, a duplicate draftId
      // earlier in this same batch, or an earlier approval entirely), or
      // the prospect's doNotContact flipped true in the interim (e.g. a
      // concurrent unsubscribe). Re-read to report the precise reason
      // rather than guessing.
      await rollBackDailySendSlot();
      const fresh = await prisma.draft.findUnique({
        where: { id: draft.id },
        select: { prospect: { select: { doNotContact: true } } },
      });
      const outcome = fresh?.prospect.doNotContact ? 'skipped_do_not_contact' : 'skipped_already_approved';
      outcomeByDraftId.set(item.draftId, { draftId: item.draftId, outcome });
      continue;
    }

    const bodyToSend = item.editedBody ?? draft.humanizedBody ?? draft.body;

    const sendResult = await sendEmail({
      to: draft.prospect.contactEmail,
      subject: draft.subject,
      body: bodyToSend,
    });

    if (!sendResult.ok) {
      // Roll back the claim so a legitimate retry can re-approve this
      // draft later - a failed send must never permanently lock a draft
      // out of ever being sent. The edited body (if any) is kept: it was
      // applied above regardless of send outcome, so a human's edit is
      // never lost just because the send attempt failed. Also persisted to
      // `lastSendFailure` - otherwise this outcome only ever exists in the
      // transient API response, with no way to find "what failed" later.
      // The reserved daily-send-cap slot is rolled back too - it never
      // corresponded to a real send.
      await rollBackDailySendSlot();
      await prisma.draft.update({
        where: { id: draft.id },
        data: {
          approved: false,
          lastSendFailure: { reason: sendResult.reason, occurredAt: new Date().toISOString() },
        },
      });
      outcomeByDraftId.set(item.draftId, { draftId: item.draftId, outcome: 'failed', reason: sendResult.reason });
      continue;
    }

    const statusHistory = Array.isArray(draft.prospect.statusHistory) ? draft.prospect.statusHistory : [];
    const sentAt = new Date();

    // Clears any prior send failure recorded on this exact draft (e.g. a
    // previous approval attempt that failed and was retried) now that a send
    // has actually succeeded - dead-letter tracking should never keep
    // reporting a stale failure for a draft that has since gone out fine.
    await prisma.draft.update({ where: { id: draft.id }, data: { lastSendFailure: Prisma.DbNull } });

    // Draft.approved is already committed (via the claim above) by the
    // time the email actually goes out, so this is just advancing the
    // prospect's status - it does not need to be transactional with the
    // claim (which must complete, and stay committed, before the external
    // send call, not alongside it).
    await prisma.prospect.update({
      where: { id: draft.prospectId },
      data: {
        status: PrismaProspectStatus.sent,
        sentAt,
        activeDraftId: draft.id,
        statusHistory: [...statusHistory, { status: PrismaProspectStatus.sent, timestamp: sentAt.toISOString() }],
      },
    });

    outcomeByDraftId.set(item.draftId, { draftId: item.draftId, outcome: 'sent' });
  }

  return items.map((item) => outcomeByDraftId.get(item.draftId) ?? { draftId: item.draftId, outcome: 'not_found' });
}
