import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Node's built-in scrypt (no new dependency, same "hand-roll the crypto"
// convention this app already follows in session.ts) - a slow, salted KDF
// appropriate for password storage, unlike the plain SHA-256 used elsewhere
// in this codebase for comparing fixed high-entropy secrets (CRON_SECRET,
// DASHBOARD_PASSWORD historically) where brute-force resistance from a slow
// hash was never the concern.
const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/** Stored as `<salt-hex>:<derived-key-hex>` - a random salt per password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verifies `password` against a hash produced by `hashPassword`. Fails
 * closed on any malformed stored value (missing salt/hash separator) rather
 * than throwing, since a corrupt stored hash should behave like "no
 * password matches", not crash the login route.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, storedKeyHex] = stored.split(':');
  if (!salt || !storedKeyHex) return false;

  const storedKey = Buffer.from(storedKeyHex, 'hex');
  const derivedKey = (await scryptAsync(password, salt, storedKey.length)) as Buffer;

  return derivedKey.length === storedKey.length && timingSafeEqual(derivedKey, storedKey);
}
