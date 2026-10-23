import { prisma } from '@/common/db/client';
import { isFollowupApprovalRequired } from '@/features/followups/followup-approval-setting';
import {
  attemptFollowupSend,
  FOLLOWUP_CANDIDATE_SELECT,
  FOLLOWUP_SEND_UNCONFIRMED_TAG,
  findDueFollowupCandidates,
  isDueForSecondTouch,
  SECOND_TOUCH,
} from '@/features/followups/followup-scheduler';
import type { CandidateProspect, FollowupSendOutcome } from '@/features/followups/followup-scheduler';
import { renderFollowupTemplate } from '@/features/followups/followup-templates';
import type { DueFollowupView, FollowupQueueResult } from '@/features/followups/followup-approval.types';
import { getEffectiveDailyCap } from '@/features/sending/domain-verification-gate';
import { reserveDailySendSlot } from '@/features/sending/daily-send-counter';
import { SEND_UNCONFIRMED_TAG } from '@/features/sending/sending.types';
import { signalSchema } from '@/features/prospects/prospect.types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Nothing is stored for "awaiting approval": a prospect is awaiting exactly
// when the scheduler would have sent to it, which is recomputed on every
// read. That keeps the queue from ever disagreeing with the scheduler about
// who is due.

function hasUnconfirmedTag(candidate: CandidateProspect): boolean {
  return candidate.tags.includes(SEND_UNCONFIRMED_TAG) || candidate.tags.includes(FOLLOWUP_SEND_UNCONFIRMED_TAG);
}

async function loadOriginalSubjects(candidates: CandidateProspect[]): Promise<Map<string, string>> {
  const draftIds = candidates.map((c) => c.activeDraftId).filter((id): id is string => id !== null);
  if (draftIds.length === 0) return new Map();

  const drafts = await prisma.draft.findMany({ where: { id: { in: draftIds } }, select: { id: true, subject: true } });
  return new Map(drafts.map((draft) => [draft.id, draft.subject]));
}

/**
 * The follow-up queue: stale `sent` prospects waiting on a human (with the
 * exact email that would go out), and prospects whose follow-up send has an
 * unconfirmed outcome. A due prospect that cannot be sent at all (no contact
 * email, no valid signal, template fails validation) is left out of `due`
 * rather than offered for an approval that could only fail.
 */
export async function listFollowupQueue(): Promise<FollowupQueueResult> {
  const now = new Date();
  const due = (await findDueFollowupCandidates(now)).filter(
    (candidate) => isDueForSecondTouch(candidate, now) && !hasUnconfirmedTag(candidate)
  );
  const originalSubjects = await loadOriginalSubjects(due);

  const dueViews: DueFollowupView[] = [];
  for (const candidate of due) {
    const referenceDate = candidate.lastFollowupAt ?? candidate.sentAt;
    const signal = signalSchema.safeParse(candidate.signal);
    if (!candidate.contactEmail || !signal.success || !referenceDate) continue;

    const rendered = renderFollowupTemplate(SECOND_TOUCH.touch, {
      companyName: candidate.companyName,
      originalSubject: candidate.activeDraftId ? (originalSubjects.get(candidate.activeDraftId) ?? null) : null,
      signal: signal.data,
    });
    if (!rendered.ok) continue;

    dueViews.push({
      prospectId: candidate.id,
      companyName: candidate.companyName,
      contactEmail: candidate.contactEmail,
      subject: rendered.template.subject,
      body: rendered.template.body,
      daysSinceLastTouch: Math.floor((now.getTime() - referenceDate.getTime()) / MS_PER_DAY),
      priorityScore: candidate.priorityScore,
    });
  }

  const unconfirmed = await prisma.prospect.findMany({
    where: { tags: { has: FOLLOWUP_SEND_UNCONFIRMED_TAG } },
    select: { id: true, companyName: true, contactEmail: true, lastFollowupAt: true },
    orderBy: { lastFollowupAt: 'desc' },
  });

  return {
    approvalRequired: isFollowupApprovalRequired(),
    due: dueViews,
    unconfirmed: unconfirmed.map((prospect) => ({
      prospectId: prospect.id,
      companyName: prospect.companyName,
      contactEmail: prospect.contactEmail,
      lastFollowupAt: prospect.lastFollowupAt ? prospect.lastFollowupAt.toISOString() : null,
    })),
  };
}

/**
 * Sends the follow-up for each requested prospect. This is the human-initiated
 * counterpart of the scheduler's send path (reached only via
 * POST /api/queue/followups/approve) and reuses its `attemptFollowupSend`, so
 * the atomic claim, the definite-failure rollback and the
 * `followup-send-unconfirmed` tagging for ambiguous failures are identical.
 *
 * For each id, highest `priorityScore` first:
 *   1. Re-reads the prospect and requires it to still be a stale `sent`
 *      prospect with `doNotContact: false` and no unconfirmed tag; anything
 *      else (replied meanwhile, already followed up, unknown id) is
 *      `skipped_not_eligible` and never reserves a cap slot.
 *   2. Reserves a daily-cap slot immediately before sending. Once the cap is
 *      hit, this id and every remaining id are `skipped_cap` without a claim.
 *
 * Returns one outcome per requested id, in request order.
 */
export async function approveFollowups(prospectIds: string[]): Promise<FollowupSendOutcome[]> {
  if (prospectIds.length === 0) return [];

  const ranked = await prisma.prospect.findMany({
    where: { id: { in: prospectIds } },
    select: { id: true, priorityScore: true },
  });
  const scoreById = new Map(ranked.map((row) => [row.id, row.priorityScore]));
  const ordered = [...prospectIds].sort(
    (a, b) => (scoreById.get(b) ?? Number.NEGATIVE_INFINITY) - (scoreById.get(a) ?? Number.NEGATIVE_INFINITY)
  );

  const outcomeById = new Map<string, FollowupSendOutcome>();
  let capReached = false;

  for (const prospectId of ordered) {
    if (capReached) {
      outcomeById.set(prospectId, { prospectId, outcome: 'skipped_cap' });
      continue;
    }

    const candidate = (await prisma.prospect.findUnique({
      where: { id: prospectId },
      select: FOLLOWUP_CANDIDATE_SELECT,
    })) as CandidateProspect | null;

    if (!candidate || !isDueForSecondTouch(candidate, new Date()) || hasUnconfirmedTag(candidate)) {
      outcomeById.set(prospectId, { prospectId, outcome: 'skipped_not_eligible' });
      continue;
    }

    // `attemptFollowupSend` rolls this slot back on every path that does not
    // end in a real (or possibly real) send.
    if (!(await reserveDailySendSlot(getEffectiveDailyCap()))) {
      capReached = true;
      outcomeById.set(prospectId, { prospectId, outcome: 'skipped_cap' });
      continue;
    }

    outcomeById.set(prospectId, await attemptFollowupSend(candidate, SECOND_TOUCH.touch, SECOND_TOUCH.nextStatus));
  }

  return prospectIds.map((id) => outcomeById.get(id) ?? { prospectId: id, outcome: 'skipped_not_eligible' });
}
