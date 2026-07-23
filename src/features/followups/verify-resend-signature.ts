import { env } from '@/common/config/env';
import { timingSafeEqual } from '@/common/auth/session';

// Resend signs outbound webhooks using the Svix scheme (see
// https://resend.com/docs/dashboard/webhooks/introduction and Svix's own
// signing docs): the secret is a `whsec_<base64>` string, and each request
// carries `svix-id` / `svix-timestamp` / `svix-signature` headers. The
// expected signature is HMAC-SHA256, keyed by the base64-decoded secret
// (after stripping the `whsec_` prefix), over the exact string
// `${svixId}.${svixTimestamp}.${rawBody}`, base64-encoded. `svix-signature`
// can carry multiple space-separated `v1,<base64>` entries (for secret
// rotation); a match against any one of them is a valid signature.
//
// This is implemented with raw Web Crypto HMAC rather than the `svix` npm
// package: the algorithm above is simple, fully documented, and this app
// already does equivalent raw-HMAC signing/verification for its own session
// cookie (see common/auth/session.ts) — adding a dependency for a few lines
// of HMAC verification would fail the "fewer dependencies" standard for no
// real benefit. Revisit if Resend's signing scheme turns out to need more of
// what the `svix` package provides (e.g. its built-in replay-tolerance
// handling) than this file reimplements.

// Rejects a signature whose `svix-timestamp` is further than this many
// seconds from now (past or future) — standard Svix replay-attack mitigation
// tolerance.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface ResendWebhookHeaders {
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function computeExpectedSignature(secretBytes: Uint8Array, signedContent: string): Promise<string> {
  const keyBytes = Uint8Array.from(secretBytes);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
  return uint8ArrayToBase64(new Uint8Array(signature));
}

function isTimestampFresh(svixTimestamp: string): boolean {
  const timestampSeconds = Number(svixTimestamp);
  if (!Number.isFinite(timestampSeconds)) return false;

  const nowSeconds = Date.now() / 1000;
  return Math.abs(nowSeconds - timestampSeconds) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/**
 * Verifies a Resend/Svix webhook signature against the raw request body.
 * Fails closed on every ambiguous case — this app's standard posture for
 * anything gating a "trust this input" decision: missing
 * `RESEND_WEBHOOK_SECRET` (can't verify, so refuse everything, per the spec's
 * explicit instruction), a malformed secret, any missing header, a stale/
 * future timestamp, or a signature that doesn't match all return `false`
 * rather than throwing or guessing.
 */
export async function verifyResendWebhookSignature(rawBody: string, headers: ResendWebhookHeaders): Promise<boolean> {
  if (!env.RESEND_WEBHOOK_SECRET) return false;

  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;
  if (!isTimestampFresh(svixTimestamp)) return false;

  const secret = env.RESEND_WEBHOOK_SECRET;
  const secretWithoutPrefix = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;

  let secretBytes: Uint8Array;
  try {
    secretBytes = base64ToUint8Array(secretWithoutPrefix);
  } catch {
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedSignature = await computeExpectedSignature(secretBytes, signedContent);

  const providedSignatures = svixSignature
    .split(' ')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of providedSignatures) {
    const [version, providedSignature] = entry.split(',');
    if (version !== 'v1' || !providedSignature) continue;
    if (providedSignature.length !== expectedSignature.length) continue;
    if (timingSafeEqual(providedSignature, expectedSignature)) return true;
  }

  return false;
}
