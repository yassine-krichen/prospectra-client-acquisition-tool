import { SEND_UNCONFIRMED_TAG } from '@/features/sending/sending.types';

// Shared, pure definition of "is a first-touch send for this prospect locked,
// and if so can a human resolve it yet". The approve pre-check, the claim
// inside approveDrafts, the queue listing and the resolve service all use it,
// so they cannot disagree.

/**
 * A send that has been claimed but not yet finished is marked on the claimed
 * draft's `lastSendFailure` as `{ inFlight: true, startedAt }` (written by the
 * claim itself). There is no Draft timestamp for the claim in the schema and
 * none may be added, so this marker is the only record of when an attempt
 * started. It is replaced by the failure record on a failed send and cleared on
 * success; if the process dies mid-send it stays behind, and once it is older
 * than SEND_IN_FLIGHT_WINDOW_MS the attempt is treated as finished-but-unknown.
 */
export function buildInFlightMarker(startedAt: Date): { inFlight: true; startedAt: string } {
  return { inFlight: true, startedAt: startedAt.toISOString() };
}

// Well beyond how long a single Resend request can legitimately take, so a
// still-running send is never mistaken for an abandoned one.
export const SEND_IN_FLIGHT_WINDOW_MS = 10 * 60 * 1000;

export interface SendLockDraft {
  approved: boolean;
  generatedAt: Date;
  lastSendFailure: unknown;
}

export interface SendLockInput {
  tags: readonly string[];
  sentAt: Date | null;
  drafts: readonly SendLockDraft[];
}

/**
 * none: nothing is locking sends for this prospect.
 * sending: an attempt started recently and may still be running. Sends stay
 *   locked and a human must NOT resolve it yet (it may still succeed).
 * unconfirmed: an attempt finished (or was abandoned) without a known outcome.
 *   Sends are locked until a human resolves it.
 */
export type SendLockState = 'none' | 'sending' | 'unconfirmed';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function isUnconfirmedFailure(lastSendFailure: unknown): boolean {
  return asRecord(lastSendFailure)?.unconfirmed === true;
}

export function isInFlightMarker(lastSendFailure: unknown): boolean {
  return asRecord(lastSendFailure)?.inFlight === true;
}

/** When the attempt recorded on this draft started or failed, if known. */
export function sendAttemptTime(lastSendFailure: unknown): Date | null {
  const record = asRecord(lastSendFailure);
  const raw = record?.occurredAt ?? record?.startedAt;
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The approved drafts that count as a live send claim for the prospect.
 *
 * Rule: a draft that is approved blocks other variants, except an approved
 * draft from before the latest recorded send (a tie counts as after, so it blocks). Re-drafting keeps `sentAt` and
 * leaves the old drafts (still approved) in place, so "approved" alone would
 * lock a re-drafted prospect forever. A draft generated after `sentAt` is a
 * new variant, so its approval is a real claim. When nothing was ever sent
 * (`sentAt` null) every approved draft blocks.
 *
 * This is not the whole protection: callers also require the prospect to be
 * `drafted`, which is what refuses a stale tab after a send has completed
 * (status has moved to `sent`).
 */
export function blockingApprovedDrafts<T extends { approved: boolean; generatedAt: Date }>(
  sentAt: Date | null,
  drafts: readonly T[]
): T[] {
  return drafts.filter(
    (draft) => draft.approved && (sentAt === null || draft.generatedAt.getTime() >= sentAt.getTime())
  );
}

export function getSendLockState(input: SendLockInput, now: Date = new Date()): SendLockState {
  if (input.tags.includes(SEND_UNCONFIRMED_TAG)) return 'unconfirmed';

  const blocking = blockingApprovedDrafts(input.sentAt, input.drafts);
  if (blocking.length === 0) return 'none';
  if (blocking.some((draft) => isUnconfirmedFailure(draft.lastSendFailure))) return 'unconfirmed';

  const stillRunning = blocking.some((draft) => {
    if (!isInFlightMarker(draft.lastSendFailure)) return false;
    const startedAt = sendAttemptTime(draft.lastSendFailure);
    // An unreadable marker cannot prove the attempt is recent, so it is not
    // treated as running: the state falls through to resolvable.
    return startedAt !== null && now.getTime() - startedAt.getTime() < SEND_IN_FLIGHT_WINDOW_MS;
  });
  if (stillRunning) return 'sending';

  // Approved, never recorded as sent, no recent attempt marker: either an
  // abandoned attempt or one claimed before the marker existed. Unknown outcome.
  return 'unconfirmed';
}

/** Whether a human can (and must) resolve this prospect's first-touch send. */
export function hasUnconfirmedSend(input: SendLockInput, now: Date = new Date()): boolean {
  return getSendLockState(input, now) === 'unconfirmed';
}
