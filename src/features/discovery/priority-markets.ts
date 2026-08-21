// Pure data + a pure lookup function - deliberately no I/O, so this stays
// safe to import from a `'use client'` component (same convention as
// discovery-source-registry.ts). This is a *scoring bonus*, not a filter -
// `geography` stays free text everywhere else in the app (see
// docs/discovery-engine-roadmap.md's "next slice" item 3); nothing here ever
// blocks or rejects a search.
//
// The list itself: high-purchasing-power/tech-services-demand US states and
// European countries, per the design conversation captured in
// docs/discovery-engine-roadmap.md.
export const PRIORITY_MARKETS: string[] = [
  // US states
  'California',
  'New York',
  'Texas',
  'Florida',
  'Washington',
  'Massachusetts',
  'New Jersey',
  'Illinois',
  'Virginia',
  'Colorado',
  'Georgia',
  'North Carolina',
  // European countries
  'UK',
  'Germany',
  'France',
  'Netherlands',
  'Switzerland',
  'Ireland',
  'Sweden',
  'Norway',
  'Denmark',
  'Belgium',
  'Austria',
  'Finland',
];

// Aliases (state abbreviations, common alternate country names) that should
// also match a `PRIORITY_MARKETS` entry, since `geography` is free text like
// "Austin, TX" or "Berlin, Germany" - the canonical list above is what's
// documented/displayed, this is what's actually matched against.
const MARKET_ALIASES: string[] = [
  ...PRIORITY_MARKETS,
  // US state postal abbreviations, in the same order as PRIORITY_MARKETS.
  'CA',
  'NY',
  'TX',
  'FL',
  'WA',
  'MA',
  'NJ',
  'IL',
  'VA',
  'CO',
  'GA',
  'NC',
  // Common alternate names for the European countries above.
  'United Kingdom',
  'England',
  'Scotland',
  'Wales',
];

const MARKET_ALIASES_LOWER: string[] = MARKET_ALIASES.map((alias) => alias.toLowerCase());

/**
 * Loose, case-insensitive check for whether free-text `geography` mentions a
 * priority market (see `PRIORITY_MARKETS`/`MARKET_ALIASES` above). Feeds a
 * flat scoring bonus in `priority-scoring.ts` - never used to filter/reject a
 * search.
 *
 * `geography` is split on commas (this app's own convention, e.g. "Austin,
 * TX" or "Berlin, Germany" - see discovery.service.ts's doc comments) and
 * each segment is matched for an EXACT (not substring) match against an
 * alias. This deliberately isn't a plain substring/word-boundary check: a
 * naive substring match on "Virginia" would incorrectly also match "West
 * Virginia" (a genuinely distinct, non-priority state) since "Virginia" is a
 * real whole word inside that name too - word boundaries alone don't help
 * here. Exact-matching a whole comma-separated segment does.
 *
 * Known, accepted limitation: this can't distinguish the US state "Georgia"
 * from the country "Georgia" (e.g. "Tbilisi, Georgia" also matches) - an
 * inherent ambiguity of free-text geography that isn't worth more machinery
 * to resolve given this app's actual prospect geography today.
 */
export function isPriorityMarket(geography: string | undefined): boolean {
  if (!geography) return false;

  const segments = geography
    .split(',')
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);

  return segments.some((segment) => MARKET_ALIASES_LOWER.includes(segment));
}
