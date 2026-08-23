import { prisma } from '@/common/db/client';

// Per-nickname login lockout, mirroring bridge-budget.ts's two-function
// shape and fail-closed philosophy - see `LoginLockout` in
// prisma/schema.prisma. Keyed by nickname only (not IP): both nicknames are
// already public (shipped to the client bundle - see known-usernames.ts) and
// this is a 2-person internal tool, so IP-based keying wasn't worth the
// added complexity.

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

/**
 * Reports whether `nickname` is currently locked out. Fails closed: if the
 * lockout record can't be read at all (e.g. a transient DB error), this
 * returns `true` - "treat it as locked out" - consistent with this repo's
 * "authorization errors deny access, always" rule (see preferences.md).
 */
export async function isLockedOut(nickname: string): Promise<boolean> {
  try {
    const record = await prisma.loginLockout.findUnique({ where: { nickname } });
    if (!record || !record.lockedUntil) return false;
    return record.lockedUntil.getTime() > Date.now();
  } catch {
    return true;
  }
}

/**
 * Records a failed login attempt for `nickname`, atomically incrementing
 * (or creating, at count 1) the failure count. Once the count reaches
 * MAX_FAILED_ATTEMPTS, locks the account for LOCKOUT_DURATION_MINUTES.
 */
export async function recordFailedAttempt(nickname: string): Promise<void> {
  const record = await prisma.loginLockout.upsert({
    where: { nickname },
    create: { nickname, failedAttempts: 1 },
    update: { failedAttempts: { increment: 1 } },
  });

  if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    await prisma.loginLockout.update({
      where: { nickname },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000) },
    });
  }
}

/**
 * Clears any lockout state for `nickname`, called on a successful login.
 */
export async function clearLockout(nickname: string): Promise<void> {
  await prisma.loginLockout.deleteMany({ where: { nickname } });
}
