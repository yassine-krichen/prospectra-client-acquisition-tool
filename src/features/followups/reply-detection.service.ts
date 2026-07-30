import { z } from 'zod';

import { Prisma, ProspectStatus as PrismaProspectStatus, ReplySentiment as PrismaReplySentiment } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';

// Processes one verified inbound-reply event (already signature-verified by
// the caller — see verify-resend-signature.ts / app/api/webhooks/resend —
// this module never trusts a payload on its own). The webhook body is the
// least-trusted input in this app, so its shape is re-validated here with
// zod regardless of whatever shape the route already extracted it into.

export const inboundReplySchema = z.object({
  fromEmail: z.string().email(),
  subject: z.string().nullable(),
  text: z.string().nullable(),
});
export type InboundReply = z.infer<typeof inboundReplySchema>;

// Prospects still "in flight" toward a follow-up — the only statuses a
// reply is allowed to transition out of. A reply for a prospect already
// `replied`/`dead`/`won`/`unsubscribed` is a no-op (idempotent — e.g. a
// duplicate webhook delivery), never a re-trigger of anything.
const REPLYABLE_STATUSES = [
  PrismaProspectStatus.sent,
  PrismaProspectStatus.followup_1,
  PrismaProspectStatus.followup_2,
  PrismaProspectStatus.followup_3,
] as const;

// Simple keyword heuristic, NOT machine learning — a small, readable,
// deliberately conservative starter list. Negative/unsubscribe-intent
// keywords are checked first and take priority over positive ones (fail
// toward "stop contacting this person" on any ambiguity, matching this app's
// fail-closed posture elsewhere): a reply containing both an opt-out phrase
// and a pleasantry is still treated as negative.
const NEGATIVE_KEYWORDS: readonly string[] = [
  'unsubscribe',
  'stop emailing',
  'stop contacting',
  'remove me',
  'not interested',
  'no thanks',
  'no thank you',
  'opt out',
  'opt-out',
  'take me off',
  'do not contact',
  "don't contact",
];

const POSITIVE_KEYWORDS: readonly string[] = [
  'interested',
  "let's chat",
  'lets chat',
  'sounds good',
  'sounds great',
  "let's talk",
  'lets talk',
  'book a call',
  'schedule a call',
  'yes please',
];

function detectSentiment(text: string): PrismaReplySentiment {
  const lower = text.toLowerCase();

  if (NEGATIVE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return PrismaReplySentiment.negative;
  }
  if (POSITIVE_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return PrismaReplySentiment.positive;
  }
  return PrismaReplySentiment.neutral;
}

export type ReplyProcessingOutcome =
  | { outcome: 'matched'; prospectId: string; sentiment: PrismaReplySentiment }
  | { outcome: 'no_match' }
  | { outcome: 'already_terminal'; prospectId: string }
  | { outcome: 'invalid_payload'; reason: string };

const PROSPECT_SELECT = {
  id: true,
  status: true,
  statusHistory: true,
} as const satisfies Prisma.ProspectSelect;

/**
 * Processes one already-signature-verified inbound reply event.
 *
 *   1. Validates `payload`'s shape with zod — fails closed (`invalid_payload`,
 *      never a crash) on anything malformed.
 *   2. Matches the sender to a `Prospect` by exact `contactEmail`. No match
 *      is logged and ignored (`no_match`) — this never guesses at a fuzzy
 *      match, and never creates a prospect from an inbound email.
 *   3. On a match: applies sentiment via `detectSentiment` (subject + body
 *      text combined), then atomically transitions the prospect —
 *      `status: 'replied'`, `repliedAt`, `replySentiment`, appended
 *      `statusHistory`, and — on negative/unsubscribe-intent sentiment —
 *      `doNotContact: true` + `unsubscribedAt` in the SAME update.
 *
 * The atomic update's `WHERE status IN REPLYABLE_STATUSES` is what actually
 * closes the reply-vs-follow-up race from the follow-up scheduler's side:
 * whichever of "the scheduler's send-claim" or "this reply update" commits
 * first wins, and the loser's own `WHERE` clause (this one keys off
 * `status`, the scheduler's keys off the exact prior `status` it read) then
 * fails to match, so a follow-up can never be sent after a reply has already
 * been recorded, and a reply is never lost/overwritten just because a
 * follow-up landed a moment earlier. A prospect already outside
 * `REPLYABLE_STATUSES` (already `replied`, or `dead`/`won`/`unsubscribed`)
 * makes this a no-op (`already_terminal`) rather than reopening it.
 */
export async function processInboundReply(payload: unknown): Promise<ReplyProcessingOutcome> {
  const parsed = inboundReplySchema.safeParse(payload);
  if (!parsed.success) {
    return { outcome: 'invalid_payload', reason: parsed.error.issues.map((issue) => issue.message).join('; ') };
  }

  const { fromEmail, subject, text } = parsed.data;

  const prospect = await prisma.prospect.findFirst({
    where: { contactEmail: fromEmail },
    select: PROSPECT_SELECT,
  });

  if (!prospect) {
    return { outcome: 'no_match' };
  }

  const sentiment = detectSentiment(`${subject ?? ''} ${text ?? ''}`);
  const isNegative = sentiment === PrismaReplySentiment.negative;
  const statusHistory = Array.isArray(prospect.statusHistory) ? prospect.statusHistory : [];
  const now = new Date();

  const claim = await prisma.prospect.updateMany({
    where: { id: prospect.id, status: { in: [...REPLYABLE_STATUSES] } },
    data: {
      status: PrismaProspectStatus.replied,
      repliedAt: now,
      replySentiment: sentiment,
      statusHistory: [...statusHistory, { status: PrismaProspectStatus.replied, timestamp: now.toISOString() }],
      ...(isNegative ? { doNotContact: true, unsubscribedAt: now } : {}),
    },
  });

  if (claim.count !== 1) {
    return { outcome: 'already_terminal', prospectId: prospect.id };
  }

  return { outcome: 'matched', prospectId: prospect.id, sentiment };
}

export type ClientReplyProcessingOutcome =
  | { outcome: 'opted_out'; clientId: string }
  | { outcome: 'acknowledged'; clientId: string }
  | { outcome: 'no_match' }
  | { outcome: 'invalid_payload'; reason: string };

const CLIENT_SELECT = {
  id: true,
  doNotContact: true,
  statusHistory: true,
} as const satisfies Prisma.ClientSelect;

/**
 * The `Client`-side counterpart to `processInboundReply` above. Retention
 * emails (`src/features/retention/`) go out against `Client.contactEmail`,
 * not `Prospect.contactEmail` — a converted prospect's `status` is `won`
 * (outside `REPLYABLE_STATUSES`), so `processInboundReply` alone can never
 * observe a reply to a retention email, meaning `Client.doNotContact` (the
 * one guard that halts the otherwise-indefinite retention cadence — see its
 * schema comment) would otherwise be unreachable. This function matches the
 * same inbound event against `Client` independently, so both this and
 * `processInboundReply` should be called for every inbound webhook event —
 * they check different tables and neither excludes the other.
 *
 * Only a negative/unsubscribe-intent reply changes anything: there's no
 * Client-side notion of "replied"/sentiment history to track (unlike
 * Prospect), just the one opt-out flag. Idempotent — a Client already
 * `doNotContact: true` stays `opted_out` on a repeat/duplicate webhook
 * delivery rather than erroring or double-appending history.
 */
export async function processInboundReplyForClient(payload: unknown): Promise<ClientReplyProcessingOutcome> {
  const parsed = inboundReplySchema.safeParse(payload);
  if (!parsed.success) {
    return { outcome: 'invalid_payload', reason: parsed.error.issues.map((issue) => issue.message).join('; ') };
  }

  const { fromEmail, subject, text } = parsed.data;

  const client = await prisma.client.findFirst({
    where: { contactEmail: fromEmail },
    select: CLIENT_SELECT,
  });

  if (!client) {
    return { outcome: 'no_match' };
  }

  const sentiment = detectSentiment(`${subject ?? ''} ${text ?? ''}`);
  if (sentiment !== PrismaReplySentiment.negative) {
    return { outcome: 'acknowledged', clientId: client.id };
  }

  if (client.doNotContact) {
    return { outcome: 'opted_out', clientId: client.id };
  }

  const statusHistory = Array.isArray(client.statusHistory) ? client.statusHistory : [];
  const now = new Date();

  // Atomic claim conditioned on the exact state just read, same principle as
  // every other claim in this codebase — a race against a concurrent
  // retention send or a second duplicate webhook delivery can't double-apply
  // or lose this.
  await prisma.client.updateMany({
    where: { id: client.id, doNotContact: false },
    data: {
      doNotContact: true,
      statusHistory: [...statusHistory, { status: 'opted_out', timestamp: now.toISOString() }],
    },
  });

  return { outcome: 'opted_out', clientId: client.id };
}
