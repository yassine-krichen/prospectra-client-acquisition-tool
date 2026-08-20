import { env } from '@/common/config/env';

// Warmup ramp schedule for a freshly-verified sending domain: one cap per
// week of warmup, [week 1, week 2, week 3, week 4, week 5+]. Roughly doubles
// each week (a conservative, commonly-recommended cold-domain warmup curve)
// before leveling off at a steady-state ceiling - the last entry, held
// indefinitely from week 5 onward until a later phase makes that ceiling
// itself a product decision. Hardcoded rather than env-configurable per the
// spec: this doesn't need to change without a code change, and a fixed
// table is simpler than a formula for a 5-step curve.
//
// IMPORTANT: this schedule only ever takes effect once
// `DOMAIN_DNS_VERIFIED` is true - domain-verification-gate.ts's
// `getEffectiveDailyCap()` overrides it down to `DAILY_SEND_CAP_TEST` while
// unverified, and that gate is the only function any send path may call.
const WEEKLY_RAMP_CAP: readonly number[] = [12, 25, 40, 60, 100];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Computes the warmup-ramp send cap for `referenceDate` (defaults to now),
 * based on days elapsed since `DOMAIN_WARMUP_START_DATE`. Falls back to the
 * most conservative (week-1) cap whenever warmup can't be confirmed to have
 * started yet: no start date configured, a malformed date, or a start date
 * in the future all count as "not warming up yet" rather than erroring.
 *
 * This is a scheduling input only, not the cap a send path should ever
 * enforce directly - see `getEffectiveDailyCap()` in
 * domain-verification-gate.ts, which is the single source of truth for that.
 */
export function getWarmupRampCap(referenceDate: Date = new Date()): number {
  const conservativeCap = WEEKLY_RAMP_CAP[0];

  if (!env.DOMAIN_WARMUP_START_DATE) return conservativeCap;

  const start = new Date(env.DOMAIN_WARMUP_START_DATE);
  if (Number.isNaN(start.getTime())) return conservativeCap;

  const daysSinceStart = Math.floor((referenceDate.getTime() - start.getTime()) / MS_PER_DAY);
  if (daysSinceStart < 0) return conservativeCap;

  const weekIndex = Math.floor(daysSinceStart / 7);
  return WEEKLY_RAMP_CAP[Math.min(weekIndex, WEEKLY_RAMP_CAP.length - 1)];
}
