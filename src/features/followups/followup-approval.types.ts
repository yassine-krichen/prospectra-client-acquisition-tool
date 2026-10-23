import { z } from 'zod';

// Shapes crossing the /api/queue/followups* boundary. Zod (not bare
// interfaces) because the queue UI validates the responses again on the
// client, same pattern as sending.types.ts.

// Each id is a real send, one after another, inside a single request. Bounded
// so one request cannot run past the route's time limit; the UI selects at
// most this many at once.
export const MAX_FOLLOWUP_APPROVALS_PER_REQUEST = 50;

// A repeated id in one request is rejected outright (400) rather than
// collapsed or processed twice - one approval click must never be able to
// trigger two sends for the same prospect.
export const approveFollowupsRequestSchema = z.object({
  prospectIds: z
    .array(z.string().min(1))
    .min(1, 'at least one prospectId is required')
    .max(MAX_FOLLOWUP_APPROVALS_PER_REQUEST, `at most ${MAX_FOLLOWUP_APPROVALS_PER_REQUEST} prospectIds per request`)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'duplicate prospectId: each prospectId may appear at most once per request',
    }),
});
export type ApproveFollowupsRequest = z.infer<typeof approveFollowupsRequestSchema>;

export const followupApprovalOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ prospectId: z.string(), outcome: z.literal('sent'), touch: z.literal(2) }),
  z.object({ prospectId: z.string(), outcome: z.literal('failed'), reason: z.string() }),
  z.object({ prospectId: z.string(), outcome: z.literal('skipped_cap') }),
  // No longer a stale `sent` prospect: replied, marked do-not-contact,
  // already followed up, or not due yet. Never sent.
  z.object({ prospectId: z.string(), outcome: z.literal('skipped_not_eligible') }),
]);
export type FollowupApprovalOutcome = z.infer<typeof followupApprovalOutcomeSchema>;

export const followupApprovalResponseSchema = z.object({
  results: z.array(followupApprovalOutcomeSchema),
});
export type FollowupApprovalResponse = z.infer<typeof followupApprovalResponseSchema>;

export const dueFollowupViewSchema = z.object({
  prospectId: z.string(),
  companyName: z.string(),
  contactEmail: z.string(),
  // The exact subject and body the send will use (same renderer).
  subject: z.string(),
  body: z.string(),
  daysSinceLastTouch: z.number().int(),
  priorityScore: z.number().int(),
});
export type DueFollowupView = z.infer<typeof dueFollowupViewSchema>;

export const unconfirmedFollowupViewSchema = z.object({
  prospectId: z.string(),
  companyName: z.string(),
  contactEmail: z.string().nullable(),
  lastFollowupAt: z.string().nullable(),
});
export type UnconfirmedFollowupView = z.infer<typeof unconfirmedFollowupViewSchema>;

export const followupQueueResultSchema = z.object({
  approvalRequired: z.boolean(),
  due: z.array(dueFollowupViewSchema),
  unconfirmed: z.array(unconfirmedFollowupViewSchema),
});
export type FollowupQueueResult = z.infer<typeof followupQueueResultSchema>;
