import { Prisma, ProspectStatus as PrismaProspectStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { getEffectiveDailyCap, isDomainVerified } from '@/features/sending/domain-verification-gate';
import { getTodaysSendCount } from '@/features/sending/daily-send-counter';
import type { QueueItemView, QueueListResult } from '@/features/sending/sending.types';

// Explicit projection - the queue view only needs enough of each prospect
// and its drafts to render a preview and let a human approve/edit, same
// "explicit data selection" pattern as prospects.repository.ts's
// LIST_ITEM_SELECT.
const QUEUE_SELECT = {
  id: true,
  companyName: true,
  contactName: true,
  contactEmail: true,
  doNotContact: true,
  priorityScore: true,
  activeDraftId: true,
  drafts: {
    select: {
      id: true,
      variant: true,
      framework: true,
      subject: true,
      body: true,
      humanizedBody: true,
      edited: true,
      approved: true,
      lastSendFailure: true,
    },
  },
} as const satisfies Prisma.ProspectSelect;

type QueueProspectRow = Prisma.ProspectGetPayload<{ select: typeof QUEUE_SELECT }>;
type QueueDraftRow = QueueProspectRow['drafts'][number];

/**
 * Picks which of a prospect's drafts to pre-select/highlight as the default
 * in the approval queue UI - all 3 variants are always sent to the client
 * (see `listApprovalQueue`), this only decides which one starts selected, in
 * priority order:
 *   1. The prospect's `activeDraftId` draft, if set (e.g. it was already
 *      approved/sent once before, or a human previously picked a variant).
 *   2. Whichever variant has a `humanizedBody` - normally variant 1, since
 *      only variant 1 is ever humanized (see drafting.service.ts) - since a
 *      humanized draft reads more naturally than a raw LLM draft.
 *   3. Variant 1, the default "primary" variant every prospect gets.
 *   4. Whatever variant has the lowest variant number, as a last resort for
 *      a shape this app's drafting flow shouldn't itself ever produce.
 * A `drafted`-status prospect with zero draft rows (shouldn't happen, but
 * not structurally impossible) yields `null`.
 */
function pickDisplayDraft(prospect: QueueProspectRow): QueueDraftRow | null {
  if (prospect.activeDraftId) {
    const active = prospect.drafts.find((draft) => draft.id === prospect.activeDraftId);
    if (active) return active;
  }

  const humanized = prospect.drafts.find((draft) => draft.humanizedBody !== null);
  if (humanized) return humanized;

  const variantOne = prospect.drafts.find((draft) => draft.variant === 1);
  if (variantOne) return variantOne;

  const sortedByVariant = [...prospect.drafts].sort((a, b) => a.variant - b.variant);
  return sortedByVariant[0] ?? null;
}

/**
 * Lists every `drafted`-status prospect for the approval queue UI (highest
 * `priorityScore` first), each with all of its draft variants (sorted by
 * variant ascending) plus which one `pickDisplayDraft` would pre-select,
 * alongside the current daily-cap status so the UI can show why an approval
 * might get skipped before a human even clicks approve.
 */
export async function listApprovalQueue(): Promise<QueueListResult> {
  const prospects = await prisma.prospect.findMany({
    where: { status: PrismaProspectStatus.drafted },
    orderBy: { priorityScore: 'desc' },
    select: QUEUE_SELECT,
  });

  const items: QueueItemView[] = prospects.map((prospect) => {
    const sortedDrafts = [...prospect.drafts].sort((a, b) => a.variant - b.variant);
    const defaultDraft = pickDisplayDraft(prospect);
    return {
      prospectId: prospect.id,
      companyName: prospect.companyName,
      contactName: prospect.contactName,
      contactEmail: prospect.contactEmail,
      doNotContact: prospect.doNotContact,
      priorityScore: prospect.priorityScore,
      drafts: sortedDrafts.map((draft) => ({
        id: draft.id,
        variant: draft.variant,
        framework: draft.framework,
        subject: draft.subject,
        body: draft.body,
        humanizedBody: draft.humanizedBody,
        edited: draft.edited,
        approved: draft.approved,
        hasSendFailure: draft.lastSendFailure !== null,
      })),
      defaultDraftId: defaultDraft?.id ?? null,
    };
  });

  const sentToday = await getTodaysSendCount();

  return {
    items,
    capStatus: {
      domainVerified: isDomainVerified(),
      effectiveDailyCap: getEffectiveDailyCap(),
      sentToday,
    },
  };
}
