import { env } from '@/common/config/env';

// Minimal shared-password gate for the dashboard (Phase 0). Not a full
// user-accounts system: there is one password, and a signed session cookie
// proves the browser knows it without ever storing the password itself.

export const SESSION_COOKIE_NAME = 'dashboard_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

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

/**
 * Creates a signed session token proving the caller authenticated with the
 * dashboard password. The token carries only an issue timestamp and an HMAC
 * signature - never the password itself.
 */
export async function createSessionToken(): Promise<string> {
  const issuedAt = Date.now().toString();
  const signature = await sign(issuedAt);
  return `${issuedAt}.${signature}`;
}

/**
 * Verifies a session token's signature and expiry. Fails closed: any
 * malformed, forged, or expired token is treated as unauthenticated.
 */
export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;

  const [issuedAt, signature] = token.split('.');
  if (!issuedAt || !signature) return false;

  const expectedSignature = await sign(issuedAt);
  if (!timingSafeEqual(signature, expectedSignature)) return false;

  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > SESSION_MAX_AGE_SECONDS * 1000) return false;

  return true;
}
