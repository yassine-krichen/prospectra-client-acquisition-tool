import { env } from '@/common/config/env';
import { getWarmupRampCap } from '@/features/sending/daily-cap';

// THE hard gate on real send volume. No SPF/DKIM/DMARC records exist on a
// real sending domain yet (as of this phase), so this module's job is to
// make it structurally impossible to send real volume until
// `DOMAIN_DNS_VERIFIED` is flipped to "true" by a human who has actually
// verified those DNS records - not a suggestion, a gate.
//
// `env.DOMAIN_DNS_VERIFIED` and `env.DAILY_SEND_CAP_TEST` must never be read
// directly by any other module in this codebase. Every send path calls
// `getEffectiveDailyCap()` below instead, so there is exactly one place this
// decision is ever made.

/**
 * The single source of truth for "how many emails may be sent today,
 * total". Returns `DAILY_SEND_CAP_TEST` whenever the domain isn't verified
 * - regardless of what the warmup ramp (`daily-cap.ts`) would otherwise
 * allow - and only consults the ramp once verified. There is no parameter
 * here a caller could use to pass through a larger cap: this function takes
 * no arguments, so a caller cannot request a bypass even by accident.
 */
export function getEffectiveDailyCap(): number {
  if (!env.DOMAIN_DNS_VERIFIED) return env.DAILY_SEND_CAP_TEST;
  return getWarmupRampCap();
}

/**
 * Read-only status for display purposes (e.g. the queue UI's "N of M sends
 * used today" banner). Does not affect, and cannot be used to influence,
 * `getEffectiveDailyCap()`'s result.
 */
export function isDomainVerified(): boolean {
  return env.DOMAIN_DNS_VERIFIED;
}
