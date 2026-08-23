import { buildBaselineFallbackSignal } from '@/features/discovery/signal-detection';
import type { Signal } from '@/features/prospects/prospect.types';

// Shared by every government business registry source (Companies House,
// Texas Comptroller) - a company's own registration date is a real, direct
// buying-intent signal (a newly registered business is actively spending on
// setup, including software/services), unlike the indirect website-staleness
// signals the rest of discovery relies on.

const RECENT_REGISTRATION_STRONG_THRESHOLD_DAYS = 90;
const RECENT_REGISTRATION_MEDIUM_THRESHOLD_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Builds a `recently_registered` signal from a registry's registration date,
 * or a generic weak fallback (`buildBaselineFallbackSignal` in
 * signal-detection.ts - same builder `buildNoSignalDetectedFallback` uses,
 * so `isBaselineSignal`'s thin-prospect check recognizes both) when the date
 * is missing or unparseable, or old enough not to be a meaningful signal on
 * its own. Pure - no I/O.
 */
export function buildRegistrySignal(registrationDate: string | null, sourceLabel: string): Signal {
  const parsed = registrationDate ? new Date(registrationDate) : null;
  const isValidDate = parsed !== null && !Number.isNaN(parsed.getTime());

  if (isValidDate) {
    const ageDays = (Date.now() - parsed.getTime()) / MS_PER_DAY;

    if (ageDays < RECENT_REGISTRATION_STRONG_THRESHOLD_DAYS) {
      return {
        type: 'recently_registered',
        description: `Registered with ${sourceLabel} within the last ${RECENT_REGISTRATION_STRONG_THRESHOLD_DAYS} days`,
        evidence: registrationDate,
        strength: 'strong',
      };
    }

    if (ageDays < RECENT_REGISTRATION_MEDIUM_THRESHOLD_DAYS) {
      return {
        type: 'recently_registered',
        description: `Registered with ${sourceLabel} within the last year`,
        evidence: registrationDate,
        strength: 'medium',
      };
    }
  }

  return buildBaselineFallbackSignal(registrationDate, `in the ${sourceLabel} listing`);
}
