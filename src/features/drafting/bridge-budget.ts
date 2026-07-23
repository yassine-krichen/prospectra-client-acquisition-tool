import { prisma } from '@/common/db/client';

// Shared cooldown state for the claude-web-bridge sibling app, persisted so
// every caller — the existing humanize() pass and Phase C's tier-2 draft-
// generation call, across separate serverless invocations that share no
// in-memory state — sees the same "is the bridge currently rate-limited"
// answer instead of each independently rediscovering it. See
// `BridgeCooldown` in prisma/schema.prisma.

/**
 * Reports whether `source` (e.g. `'claude-bridge'`) is currently known to be
 * rate-limited. Fails closed: if the cooldown record can't be read at all
 * (e.g. a transient DB error), this returns `true` — "treat it as in
 * cooldown" — so a lookup failure can never accidentally spend the scarce
 * bridge budget. This is the one place in this module where "fail closed"
 * means the opposite of "assume available": spending an unverified bridge
 * call is the unsafe direction here, not withholding one.
 */
export async function isBridgeInCooldown(source: string): Promise<boolean> {
  try {
    const record = await prisma.bridgeCooldown.findUnique({ where: { source } });
    if (!record || !record.blockedUntil) return false;
    return record.blockedUntil.getTime() > Date.now();
  } catch {
    return true;
  }
}

/**
 * Records that `source` just returned a 429, upserting `blockedUntil` to
 * `retryAfterSeconds` from now. Called from every bridge call site that can
 * receive a 429 (`humanize()` and the new `generateDraft()`), so a rate
 * limit discovered by either lane is immediately visible to both.
 */
export async function recordBridgeRateLimit(source: string, retryAfterSeconds: number): Promise<void> {
  const blockedUntil = new Date(Date.now() + retryAfterSeconds * 1000);

  await prisma.bridgeCooldown.upsert({
    where: { source },
    create: { source, blockedUntil },
    update: { blockedUntil },
  });
}
