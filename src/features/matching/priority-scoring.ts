import { isPriorityMarket } from '@/features/discovery/priority-markets';
import type { DiscoveredProspect } from '@/features/discovery/discovery.types';
import type { CompanySize, SignalStrength } from '@/features/prospects/prospect.types';

// First-cut weighted scoring formula for `Prospect.priorityScore` - not the
// full per-dimension explainable scoring model described as a later item in
// docs/discovery-engine-roadmap.md (business fit + buying intent + pain
// severity + company value + contactability + geography + evidence
// confidence, each independently explainable). This is deliberately a flat,
// simple weighted sum instead: enough to meaningfully rank prospects today,
// with every weight below tunable - these numbers aren't derived from data,
// they're a reasonable starting point to adjust once real send/reply data
// exists to validate against.

/** Base/dominant factor - the strength of the single strongest signal found. */
const SIGNAL_STRENGTH_WEIGHT: Record<SignalStrength, number> = {
  weak: 10,
  medium: 20,
  strong: 30,
};

/** Bigger company = more budget capacity, but capped so it can never
 * dominate the signal-strength base above. */
const COMPANY_SIZE_WEIGHT: Record<CompanySize, number> = {
  unknown: 0,
  '1-10': 5,
  '11-50': 10,
  '51-200': 15,
  '201+': 20,
};

/** Each contactability channel is worth the same +5; a prospect with real
 * contact info is more actionable than one without, at equal signal
 * strength. */
const CONTACTABILITY_WEIGHT_PER_CHANNEL = 5;

/** Each corroborating source beyond the first is worth +8, capped at 3
 * "extra" sources (+24 max) - more independent sources finding the same
 * business is stronger confidence it's real and active, but shouldn't be
 * able to outweigh the signal-strength base on its own. */
const CORROBORATION_WEIGHT_PER_EXTRA_SOURCE = 8;
const CORROBORATION_BONUS_CAP = 24;

/** Flat bonus for a geography matching `isPriorityMarket` - see
 * priority-markets.ts. Never a hard filter, just a scoring nudge. */
const PRIORITY_MARKET_BONUS = 10;

export interface ComputePriorityScoreOptions {
  geography?: string;
}

function contactabilityBonus(prospect: DiscoveredProspect): number {
  let bonus = 0;
  if (prospect.domain !== null || prospect.websiteUrl !== null) bonus += CONTACTABILITY_WEIGHT_PER_CHANNEL;
  if (prospect.phone !== null) bonus += CONTACTABILITY_WEIGHT_PER_CHANNEL;
  if (prospect.address !== null) bonus += CONTACTABILITY_WEIGHT_PER_CHANNEL;
  return bonus;
}

function corroborationBonus(prospect: DiscoveredProspect): number {
  const extraSources = Math.max(0, prospect.corroboratingSourceCount - 1);
  return Math.min(extraSources * CORROBORATION_WEIGHT_PER_EXTRA_SOURCE, CORROBORATION_BONUS_CAP);
}

/**
 * Computes `Prospect.priorityScore`: signal strength (base) + a capped
 * company-size bonus + a capped contactability bonus + a capped
 * corroboration bonus + a flat priority-market bonus. See the weight
 * constants above for the exact numbers and the reasoning behind each.
 */
export function computePriorityScore(prospect: DiscoveredProspect, options: ComputePriorityScoreOptions = {}): number {
  return (
    SIGNAL_STRENGTH_WEIGHT[prospect.signal.strength] +
    COMPANY_SIZE_WEIGHT[prospect.companySize] +
    contactabilityBonus(prospect) +
    corroborationBonus(prospect) +
    (isPriorityMarket(options.geography) ? PRIORITY_MARKET_BONUS : 0)
  );
}
