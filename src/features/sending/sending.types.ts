import { z } from 'zod';

// Shared shapes for the Stage 3 send queue (resend.client.ts,
// send-queue.service.ts, queue-listing.ts) and the queue UI that consumes
// them over HTTP. External calls degrade to a typed `ok:false` instead of
// throwing, and every batch operation reports one outcome per item rather
// than succeeding/failing opaquely as a whole - same conventions as
// drafting.types.ts / enrichment.types.ts. Response shapes crossing the
// `/api/queue*` boundary are Zod schemas (validated again on the client,
// same pattern as `prospectListItemSchema` in prospect.types.ts) rather than
// bare interfaces, since those are the ones an API consumer must not just
// trust.

// Added to a prospect whose first-touch send failed ambiguously (timeout,
// 5xx, unparseable response): the email may have been delivered, so the
// approval queue refuses to send any variant for it until an operator has
// checked the provider dashboard and cleared the tag.
export const SEND_UNCONFIRMED_TAG = 'send-unconfirmed';

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface SendEmailSuccess {
  ok: true;
  /** Resend's message id for the sent email. */
  id: string;
}

export interface SendEmailFailure {
  ok: false;
  /** Human-readable reason, e.g. "resend responded with 422". */
  reason: string;
  /** True only when the provider definitively did not send (missing config,
   * or a 4xx rejection). Absent/false means ambiguous (timeout, 5xx,
   * unparseable response): the email may have been delivered, so callers
   * that must never double-send have to treat it as possibly sent. */
  definitelyNotSent?: boolean;
}

export type SendEmailResult = SendEmailSuccess | SendEmailFailure;

// One requested approval. `editedBody` is set when a human tweaked the
// draft body in the queue UI before approving - applied to `Draft.body`
// (with `edited: true`) before the send attempt uses it.
export const approvalRequestItemSchema = z.object({
  draftId: z.string().min(1),
  editedBody: z.string().min(1).optional(),
});
export type ApprovalRequestItem = z.infer<typeof approvalRequestItemSchema>;

// Each approval is a real send, one after another, inside a single request.
// Bounded so one request cannot run past the route's time limit.
export const MAX_APPROVALS_PER_REQUEST = 50;

// The full POST /api/queue/approve body. A repeated `draftId` in one
// request is rejected outright (fail closed, 400) rather than silently
// collapsed or processed more than once - a batch that names the same
// draft three times must never be able to trigger three real sends for one
// approval click.
export const approvalBatchRequestSchema = z.object({
  approvals: z
    .array(approvalRequestItemSchema)
    .min(1, 'at least one approval is required')
    .max(MAX_APPROVALS_PER_REQUEST, `at most ${MAX_APPROVALS_PER_REQUEST} approvals per request`)
    .refine((approvals) => new Set(approvals.map((item) => item.draftId)).size === approvals.length, {
      message: 'duplicate draftId in approvals: each draftId may appear at most once per request',
    }),
});
export type ApprovalBatchRequest = z.infer<typeof approvalBatchRequestSchema>;

export const approvalOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ draftId: z.string(), outcome: z.literal('sent') }),
  z.object({ draftId: z.string(), outcome: z.literal('failed'), reason: z.string() }),
  z.object({ draftId: z.string(), outcome: z.literal('skipped_cap') }),
  z.object({ draftId: z.string(), outcome: z.literal('skipped_do_not_contact') }),
  // The draft was already approved - by an earlier item in this same
  // batch, by a concurrent/overlapping request racing this one, or by an
  // entirely separate prior approval - and so was never sent again here.
  // Reported distinctly from `sent` and `failed` so a human can tell "this
  // one didn't need sending" apart from "this one just went out" or "this
  // one broke".
  z.object({ draftId: z.string(), outcome: z.literal('skipped_already_approved') }),
  z.object({ draftId: z.string(), outcome: z.literal('not_found') }),
]);
export type ApprovalOutcome = z.infer<typeof approvalOutcomeSchema>;

export const approvalBatchResponseSchema = z.object({
  results: z.array(approvalOutcomeSchema),
});
export type ApprovalBatchResponse = z.infer<typeof approvalBatchResponseSchema>;

export const queueDraftViewSchema = z.object({
  id: z.string(),
  variant: z.number().int(),
  // Which copywriting framework (drafting/prompt-templates.ts's
  // `FrameworkId`) generated this variant, e.g. "pas". Null for older rows
  // predating this column - see `Draft.framework`'s doc comment in
  // prisma/schema.prisma.
  framework: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  humanizedBody: z.string().nullable(),
  edited: z.boolean(),
  approved: z.boolean(),
  // Whether `Draft.lastSendFailure` is set - see that column's doc comment
  // in prisma/schema.prisma. Only the boolean crosses the wire (not the
  // failure detail itself): this is a minimal "something went wrong, retry
  // or investigate" indicator for the queue UI, not a dedicated failures view.
  hasSendFailure: z.boolean(),
  // True when `lastSendFailure.unconfirmed` is set: the send's outcome is
  // unknown (the email may have gone out), as opposed to a definite failure.
  sendUnconfirmed: z.boolean(),
});
export type QueueDraftView = z.infer<typeof queueDraftViewSchema>;

export const queueItemViewSchema = z.object({
  prospectId: z.string(),
  companyName: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  doNotContact: z.boolean(),
  // Prospect carries SEND_UNCONFIRMED_TAG: sending is locked for every variant.
  sendUnconfirmed: z.boolean(),
  // A send for this prospect was claimed moments ago and may still be running:
  // sending is locked, and it cannot be resolved yet.
  sendInFlight: z.boolean(),
  priorityScore: z.number().int(),
  /**
   * Every draft variant this prospect has (normally 3), sorted by variant
   * ascending. Empty only if a `drafted`-status prospect somehow has zero
   * draft rows.
   */
  drafts: z.array(queueDraftViewSchema),
  /**
   * Which `drafts[].id` `pickDisplayDraft` (queue-listing.ts) would choose -
   * the variant the queue UI pre-selects/highlights by default. Null only
   * when `drafts` is empty.
   */
  defaultDraftId: z.string().nullable(),
});
export type QueueItemView = z.infer<typeof queueItemViewSchema>;

export const queueCapStatusSchema = z.object({
  domainVerified: z.boolean(),
  effectiveDailyCap: z.number().int(),
  sentToday: z.number().int(),
});
export type QueueCapStatus = z.infer<typeof queueCapStatusSchema>;

export const queueListResultSchema = z.object({
  items: z.array(queueItemViewSchema),
  capStatus: queueCapStatusSchema,
});
export type QueueListResult = z.infer<typeof queueListResultSchema>;

// POST /api/prospects/[id]/resolve-unconfirmed: a human has checked the
// provider dashboard and says whether an unconfirmed send was delivered.
export const resolveUnconfirmedRequestSchema = z.object({
  outcome: z.enum(['delivered', 'not_delivered']),
});
export type ResolveUnconfirmedRequest = z.infer<typeof resolveUnconfirmedRequestSchema>;

export const resolveUnconfirmedResultSchema = z.object({
  // resolved: the send's state was settled as asked.
  // tag_cleared_only: a follow-up marked "not delivered" whose prospect had
  //   since replied, died or opted out, so only the tag was cleared.
  // nothing_to_resolve: no unconfirmed send (any more) - e.g. already resolved.
  // send_in_progress: the send was claimed recently and may still be running,
  //   so nothing can be answered yet.
  outcome: z.enum(['resolved', 'tag_cleared_only', 'nothing_to_resolve', 'send_in_progress']),
});
export type ResolveUnconfirmedResult = z.infer<typeof resolveUnconfirmedResultSchema>;
