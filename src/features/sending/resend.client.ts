import { z } from 'zod';

import { env } from '@/common/config/env';
import type { SendEmailInput, SendEmailResult } from '@/features/sending/sending.types';

const RESEND_URL = 'https://api.resend.com/emails';

// Aborts a request that hangs, so a stalled connection cannot hold a claimed
// draft "in flight" indefinitely. An abort rejects fetch, which is reported as
// an ambiguous failure (the email may still have been delivered), never as
// definitelyNotSent. This MUST stay well below SEND_IN_FLIGHT_WINDOW_MS in
// unconfirmed-send.ts (10 minutes): that window is how long a claimed send is
// trusted to still be running before it is treated as abandoned and made
// resolvable, so a request that could outlive it could be resolved as "not
// delivered" and then sent a second time while still succeeding.
export const RESEND_REQUEST_TIMEOUT_MS = 30_000;

// Fixed local part for the outbound `from` address - this app only ever
// sends from one mailbox purpose (cold outreach), so there's no need for a
// configurable local part on top of the configurable SENDING_DOMAIN.
const FROM_LOCAL_PART = 'outreach';

// Minimal subset of Resend's send-email response this client relies on. See
// https://resend.com/docs/api-reference/emails/send-email.
const resendSuccessSchema = z.object({ id: z.string() });
const resendErrorSchema = z.object({ message: z.string() });

/**
 * Builds the outbound `from` address, e.g. `outreach@example.com`. Returns
 * `null` when `SENDING_DOMAIN` isn't configured - no sending domain is owned
 * yet as of this phase - so callers must treat that as "can't send", never
 * synthesize a fallback domain.
 */
export function buildFromAddress(): string | null {
  if (!env.SENDING_DOMAIN) return null;
  return `${FROM_LOCAL_PART}@${env.SENDING_DOMAIN}`;
}

/**
 * Sends a single email via the Resend API. Never throws: a missing
 * `RESEND_API_KEY`, an unbuildable `from` address (no `SENDING_DOMAIN`), a
 * network error, a non-2xx response, or a response that doesn't match the
 * expected shape all degrade to a typed `ok:false` result - the same
 * graceful-degradation pattern as every other external client in this
 * codebase (gemini.client.ts, hunter.source.ts, etc).
 *
 * This client has no opinion on whether sending is currently *allowed* - the
 * daily cap and do-not-contact checks live in send-queue.service.ts, which
 * is the only caller of this function. Nothing here checks
 * `DOMAIN_DNS_VERIFIED` or any cap; it just attempts one send.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, reason: 'resend not configured: RESEND_API_KEY is not set', definitelyNotSent: true };
  }

  const from = buildFromAddress();
  if (!from) {
    return { ok: false, reason: 'resend not configured: SENDING_DOMAIN is not set', definitelyNotSent: true };
  }

  let response: Response;
  try {
    response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: input.to, subject: input.subject, text: input.body }),
      signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: `resend request failed (${(error as Error).message})` };
  }

  const json: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsedError = resendErrorSchema.safeParse(json);
    const detail = parsedError.success ? `: ${parsedError.data.message}` : '';
    // A 4xx means Resend rejected the request before sending, except 408
    // (request timeout), which can race a send that still completes.
    const rejectedBeforeSend = response.status >= 400 && response.status < 500 && response.status !== 408;
    return { ok: false, reason: `resend responded with ${response.status}${detail}`, definitelyNotSent: rejectedBeforeSend };
  }

  const parsed = resendSuccessSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: 'resend response did not match the expected shape' };
  }

  return { ok: true, id: parsed.data.id };
}
