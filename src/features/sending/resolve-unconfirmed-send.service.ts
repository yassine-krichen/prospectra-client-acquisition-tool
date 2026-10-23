import { Prisma, ProspectStatus as PrismaProspectStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { FOLLOWUP_SEND_UNCONFIRMED_TAG } from '@/features/followups/followup-scheduler';
import { SEND_UNCONFIRMED_TAG } from '@/features/sending/sending.types';
import type { ResolveUnconfirmedRequest, ResolveUnconfirmedResult } from '@/features/sending/sending.types';
import {
  blockingApprovedDrafts,
  getSendLockState,
  isUnconfirmedFailure,
  sendAttemptTime,
} from '@/features/sending/unconfirmed-send';

// A send whose outcome is unknown (timeout, 5xx) leaves the prospect locked
// until a human checks the provider dashboard. This is the in-app way to say
// what they found, replacing hand-editing tags. Nothing here sends an email.

export type ResolveUnconfirmedOutcome = { outcome: 'not_found' } | ResolveUnconfirmedResult;

// Thrown inside the transaction to roll it back when the guarded prospect
// update matched no row (someone else resolved it, or its state moved on).
class NothingToResolveError extends Error {}

const PROSPECT_SELECT = {
  id: true,
  status: true,
  sentAt: true,
  tags: true,
  statusHistory: true,
  followupCount: true,
  drafts: { select: { id: true, approved: true, generatedAt: true, lastSendFailure: true } },
} as const satisfies Prisma.ProspectSelect;

type ProspectRow = Prisma.ProspectGetPayload<{ select: typeof PROSPECT_SELECT }>;
type DraftRow = ProspectRow['drafts'][number];
type Tx = Prisma.TransactionClient;

function without(tags: string[], tag: string): string[] {
  return tags.filter((existing) => existing !== tag);
}

// The draft whose send is in doubt: one of the live approved drafts,
// preferring the one that recorded `lastSendFailure.unconfirmed`.
function pickUnconfirmedDraft(blocking: DraftRow[]): DraftRow | null {
  return blocking.find((draft) => isUnconfirmedFailure(draft.lastSendFailure)) ?? blocking[0] ?? null;
}

async function resolveFirstTouch(
  tx: Tx,
  prospect: ProspectRow,
  outcome: ResolveUnconfirmedRequest['outcome']
): Promise<ResolveUnconfirmedResult> {
  // The lock state was decided in code under the prospect row lock, so the
  // guard here only needs to catch writers that do not take that lock (a
  // reply webhook moving status).
  const guard: Prisma.ProspectWhereInput = {
    id: prospect.id,
    status: PrismaProspectStatus.drafted,
    sentAt: prospect.sentAt,
  };
  const clearedTags = without(prospect.tags, SEND_UNCONFIRMED_TAG);
  const blocking = blockingApprovedDrafts(prospect.sentAt, prospect.drafts);

  if (outcome === 'delivered') {
    const draft = pickUnconfirmedDraft(blocking);
    const sentAt = (draft && sendAttemptTime(draft.lastSendFailure)) ?? new Date();
    const statusHistory = Array.isArray(prospect.statusHistory) ? prospect.statusHistory : [];

    const claim = await tx.prospect.updateMany({
      where: guard,
      data: {
        status: PrismaProspectStatus.sent,
        sentAt,
        ...(draft ? { activeDraftId: draft.id } : {}),
        statusHistory: [...statusHistory, { status: PrismaProspectStatus.sent, timestamp: sentAt.toISOString() }],
        tags: { set: clearedTags },
      },
    });
    if (claim.count !== 1) throw new NothingToResolveError();

    if (draft) {
      await tx.draft.update({ where: { id: draft.id }, data: { lastSendFailure: Prisma.DbNull } });
    }
    return { outcome: 'resolved' };
  }

  const claim = await tx.prospect.updateMany({ where: guard, data: { tags: { set: clearedTags } } });
  if (claim.count !== 1) throw new NothingToResolveError();

  // Unapproving lets approveDrafts claim a variant again. Only the live
  // claims are unapproved: an older approved draft from before a re-draft
  // really was sent and stays as it is. The daily-cap slot the unconfirmed
  // send reserved is deliberately NOT given back: it may belong to an earlier
  // UTC day, and decrementing today's counter for it would hand out a send
  // slot that was never freed.
  if (blocking.length > 0) {
    await tx.draft.updateMany({
      where: { id: { in: blocking.map((draft) => draft.id) } },
      data: { approved: false, lastSendFailure: Prisma.DbNull },
    });
  }
  return { outcome: 'resolved' };
}

async function resolveFollowup(
  tx: Tx,
  prospect: ProspectRow,
  outcome: ResolveUnconfirmedRequest['outcome']
): Promise<ResolveUnconfirmedResult> {
  const clearedTags = without(prospect.tags, FOLLOWUP_SEND_UNCONFIRMED_TAG);
  const tagGuard = { tags: { has: FOLLOWUP_SEND_UNCONFIRMED_TAG } };

  if (outcome === 'delivered') {
    // The follow-up claim already moved the prospect to followup_1 and set
    // lastFollowupAt, so a delivered follow-up needs nothing but the tag gone.
    const claim = await tx.prospect.updateMany({
      where: { id: prospect.id, ...tagGuard },
      data: { tags: { set: clearedTags } },
    });
    if (claim.count !== 1) throw new NothingToResolveError();
    return { outcome: 'resolved' };
  }

  if (prospect.status !== PrismaProspectStatus.followup_1) {
    // Replied, dead or opted out since: reverting would overwrite that.
    const claim = await tx.prospect.updateMany({
      where: { id: prospect.id, ...tagGuard },
      data: { tags: { set: clearedTags } },
    });
    if (claim.count !== 1) throw new NothingToResolveError();
    return { outcome: 'tag_cleared_only' };
  }

  // Undo the follow-up claim so the prospect is a stale `sent` prospect again
  // (due for approval, or for the scheduler if approval is off).
  const statusHistory = Array.isArray(prospect.statusHistory) ? prospect.statusHistory : [];
  const last = statusHistory[statusHistory.length - 1];
  const lastIsFollowup =
    typeof last === 'object' && last !== null && !Array.isArray(last) && last.status === PrismaProspectStatus.followup_1;

  const claim = await tx.prospect.updateMany({
    where: {
      id: prospect.id,
      status: PrismaProspectStatus.followup_1,
      followupCount: prospect.followupCount,
      ...tagGuard,
    },
    data: {
      status: PrismaProspectStatus.sent,
      lastFollowupAt: null,
      followupCount: Math.max(prospect.followupCount - 1, 0),
      statusHistory: lastIsFollowup ? statusHistory.slice(0, -1) : statusHistory,
      tags: { set: clearedTags },
    },
  });
  if (claim.count !== 1) throw new NothingToResolveError();
  return { outcome: 'resolved' };
}

async function resolveInTransaction(
  tx: Tx,
  prospectId: string,
  outcome: ResolveUnconfirmedRequest['outcome']
): Promise<ResolveUnconfirmedOutcome> {
  // The same row lock approveDrafts takes for its claim. Without it, a
  // "not delivered" answer could interleave with a send that is still being
  // claimed or run, and unapprove a draft out from under it.
  await tx.$queryRaw`SELECT id FROM "Prospect" WHERE id = ${prospectId} FOR UPDATE`;

  const found = await tx.prospect.findUnique({ where: { id: prospectId }, select: PROSPECT_SELECT });
  if (!found) return { outcome: 'not_found' };
  let prospect: ProspectRow = found;

  // A first-touch tag on a prospect that has moved past `drafted` (it replied,
  // was sent by other means, died) is stale: there is no draft to unapprove
  // and nothing to send. Clear it so it is not a dead end, then carry on in
  // case a follow-up tag is also present.
  let staleTagCleared = false;
  if (prospect.tags.includes(SEND_UNCONFIRMED_TAG) && prospect.status !== PrismaProspectStatus.drafted) {
    const cleared = await tx.prospect.updateMany({
      where: { id: prospect.id, tags: { has: SEND_UNCONFIRMED_TAG } },
      data: { tags: { set: without(prospect.tags, SEND_UNCONFIRMED_TAG) } },
    });
    if (cleared.count !== 1) throw new NothingToResolveError();
    prospect = { ...prospect, tags: without(prospect.tags, SEND_UNCONFIRMED_TAG) };
    staleTagCleared = true;
  }

  if (prospect.status === PrismaProspectStatus.drafted) {
    const lockState = getSendLockState(prospect);
    // The attempt may still be running; answering now could duplicate or
    // misrecord a send that is about to succeed.
    if (lockState === 'sending') return { outcome: 'send_in_progress' };
    if (lockState === 'unconfirmed') return resolveFirstTouch(tx, prospect, outcome);
  }

  if (prospect.tags.includes(FOLLOWUP_SEND_UNCONFIRMED_TAG)) return resolveFollowup(tx, prospect, outcome);
  return { outcome: staleTagCleared ? 'tag_cleared_only' : 'nothing_to_resolve' };
}

/**
 * Settles an unconfirmed send after a human has checked the provider
 * dashboard. All writes happen in one transaction, under the prospect row
 * lock, as guarded `updateMany`s (the prospect first), so a concurrent
 * resolve, or a state change since the read, aborts everything instead of
 * half-applying.
 *
 * First touch (see `getSendLockState`: the `send-unconfirmed` tag, or an
 * approved draft whose attempt is no longer recent):
 *   - delivered: the prospect becomes `sent` (at the time the failure was
 *     recorded) with that draft active.
 *   - not_delivered: the live approved draft(s) are unapproved so they can be
 *     sent again.
 *   - send_in_progress: the attempt started recently and may still be
 *     running, so neither answer is accepted yet.
 *   - a stale first-touch tag on a prospect that is no longer `drafted` is
 *     just cleared.
 * Follow-up (`followup-send-unconfirmed`):
 *   - delivered: tag cleared.
 *   - not_delivered: reverted to a stale `sent` prospect, or just untagged if
 *     it has since replied/died/opted out.
 * If both tags are present the first-touch one is resolved first; the
 * follow-up one stays resolvable on the next call (or in the same call when
 * the first-touch tag was only stale).
 *
 * A wrong "not_delivered" sends a duplicate email, which is why the UI asks
 * for confirmation before calling this.
 */
export async function resolveUnconfirmedSend(
  prospectId: string,
  outcome: ResolveUnconfirmedRequest['outcome']
): Promise<ResolveUnconfirmedOutcome> {
  try {
    return await prisma.$transaction((tx) => resolveInTransaction(tx, prospectId, outcome));
  } catch (error) {
    if (error instanceof NothingToResolveError) return { outcome: 'nothing_to_resolve' };
    throw error;
  }
}
