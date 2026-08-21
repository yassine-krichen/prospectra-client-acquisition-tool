// Pure, env-free source metadata - deliberately does NOT import
// `@/common/config/env` so it stays safe to import from a `'use client'`
// component (see the client-bundle-leak hazard documented in the repo root
// CLAUDE.md). This is the single source of truth for which discovery
// sources exist, what branch they belong to, and whether they're paid -
// both `discovery.service.ts` (server-side orchestration) and
// `discovery-trigger-form.tsx` (client-side checklist UI) read from here
// instead of duplicating this list.
export interface DiscoverySourceMeta {
  key: string;
  displayName: string;
  paid: boolean;
  /** Env var this source needs to be considered "configured", or `null` if
   * it needs no key at all (e.g. a Playwright scrape). */
  envVarName: string | null;
  /** Which branch this source runs under, or `null` for a branch-independent
   * source (BuiltWith, which enriches whatever prospects were already found
   * rather than discovering its own). */
  branch: 'a' | 'b' | null;
  /** Static, human-authored note about a known real-world problem with this
   * source (e.g. a valid-looking key that still fails at request time for a
   * reason not detectable from configuration alone). Surfaced in the
   * discovery trigger UI so the issue is visible before a run, not just
   * after. Deliberately static - no live health-check infrastructure. */
  knownIssue?: string;
}

export const DISCOVERY_SOURCES: DiscoverySourceMeta[] = [
  {
    key: 'google_places',
    displayName: 'Google Places',
    paid: true,
    envVarName: 'GOOGLE_PLACES_API_KEY',
    branch: 'a',
    knownIssue:
      'Billing not enabled on this Google Cloud project — requests fail with REQUEST_DENIED despite the key being valid.',
  },
  {
    key: 'yellowpages',
    displayName: 'Yellow Pages',
    paid: false,
    envVarName: null,
    branch: 'a',
  },
  {
    key: 'product_hunt',
    displayName: 'Product Hunt',
    paid: false,
    envVarName: 'PRODUCT_HUNT_API_TOKEN',
    branch: 'b',
    knownIssue: 'Token appears expired/revoked — regenerate at producthunt.com/v2/oauth/applications.',
  },
  {
    key: 'crunchbase',
    displayName: 'Crunchbase',
    paid: true,
    envVarName: 'CRUNCHBASE_API_KEY',
    branch: 'b',
  },
  {
    key: 'github',
    displayName: 'GitHub',
    paid: false,
    envVarName: 'GITHUB_TOKEN',
    branch: 'b',
  },
  {
    key: 'indiehackers',
    displayName: 'Indie Hackers',
    paid: false,
    envVarName: null,
    branch: 'b',
  },
  {
    key: 'builtwith',
    displayName: 'BuiltWith',
    paid: false,
    envVarName: 'BUILTWITH_API_KEY',
    branch: null,
  },
];
