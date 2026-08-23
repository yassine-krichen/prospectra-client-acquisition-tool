import { env } from '@/common/config/env';

// Two-account auth (Noel / EvilWithin - see known-usernames.ts). A signed,
// self-verifying session cookie proves the browser was issued a token for a
// specific userId+nickname after a real password check in
// app/api/login/route.ts - this module never touches the database itself.
//
// Deliberately non-expiring by design (the user's explicit call): there is
// no age check anywhere in `verifySessionToken` below, so a token stays
// valid until the browser stops sending it (logout) or `SESSION_SECRET`
// changes. The one unavoidable real-world limit is the cookie itself, not
// this token: Chrome (and other modern browsers) hard-cap a cookie's
// Max-Age/Expires at 400 days regardless of what's set, so
// `SESSION_COOKIE_MAX_AGE_SECONDS` below uses that ceiling - the session
// stays valid past that, but the browser will have already dropped the
// cookie by then, so in practice logging in again resets that 400-day
// clock.
export const SESSION_COOKIE_NAME = 'dashboard_session';
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return toBase64Url(signature);
}

// Constant-time comparison so signature checks don't leak timing information.
// Callers comparing variable-length secrets (e.g. passwords) must hash them
// to a fixed-length digest first with `sha256Hex` - otherwise the early
// length check below still leaks the secret's length.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Hashes a string to a fixed-length hex digest so that variable-length
// secrets (e.g. passwords) can be compared with `timingSafeEqual` without
// leaking their length via the comparison's early length check.
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface SessionPayload {
  userId: string;
  nickname: string;
}

// Neither `userId` (a cuid) nor `nickname` (one of KNOWN_USERNAMES) can ever
// contain a `.`, so joining/splitting on it is unambiguous - same
// dot-joined-then-signed shape the previous single-password token used.
function encodePayload(payload: SessionPayload, issuedAt: string): string {
  return `${payload.userId}.${payload.nickname}.${issuedAt}`;
}

/**
 * Creates a signed session token binding the browser to a specific
 * userId+nickname, proving the caller passed the real password check in
 * `app/api/login/route.ts`. Carries an issue timestamp for display purposes
 * only (e.g. "signed in since") - see the module doc comment for why
 * nothing here ever rejects a token for being old.
 */
export async function createSessionToken(payload: SessionPayload): Promise<string> {
  const issuedAt = Date.now().toString();
  const encoded = encodePayload(payload, issuedAt);
  const signature = await sign(encoded);
  return `${encoded}.${signature}`;
}

/**
 * Verifies a session token's signature. Fails closed: any malformed or
 * forged token is treated as unauthenticated. Deliberately has no expiry
 * check - see the module doc comment.
 */
export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;

  const [userId, nickname, issuedAt, signature] = token.split('.');
  if (!userId || !nickname || !issuedAt || !signature) return null;

  const expectedSignature = await sign(encodePayload({ userId, nickname }, issuedAt));
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  return { userId, nickname };
}
