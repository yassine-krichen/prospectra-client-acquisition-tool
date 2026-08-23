import * as cheerio from 'cheerio';

import { fetchSafely } from '@/common/net/is-safe-fetch-target';
import type { Signal, SignalStrength } from '@/features/prospects/prospect.types';

// The only signal source in this phase that needs zero API keys - HTTPS,
// viewport meta tag, footer copyright year, and schema.org markup can all be
// checked from a single page fetch.

const STALE_COPYRIGHT_THRESHOLD_YEARS = 3;

const SIGNAL_STRENGTH_ORDER: Record<SignalStrength, number> = {
  weak: 1,
  medium: 2,
  strong: 3,
};

function strongestSignal(candidates: Signal[]): Signal | null {
  if (candidates.length === 0) return null;

  return candidates.reduce((strongest, candidate) =>
    SIGNAL_STRENGTH_ORDER[candidate.strength] > SIGNAL_STRENGTH_ORDER[strongest.strength]
      ? candidate
      : strongest
  );
}

function extractCopyrightYear(pageText: string): number | null {
  const match = pageText.match(/(?:©|\(c\)|copyright)\s*(\d{4})/i);
  if (!match) return null;

  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

/**
 * Fetches a website and checks it for staleness/technical-debt markers.
 * Returns `null` when the site is unreachable or no marker was found - it
 * never fabricates a signal to satisfy a caller that needs one; callers
 * decide their own fallback (see `buildNoSignalDetectedFallback`).
 */
export async function detectWebsiteSignals(websiteUrl: string): Promise<Signal | null> {
  let html: string;

  try {
    // `websiteUrl` comes from scraped/attacker-writable sources (Google
    // Places, yellowpages listings), so it's validated - and every redirect
    // hop re-validated - against private/loopback/link-local targets before
    // being fetched. See `fetchSafely`.
    const response = await fetchSafely(websiteUrl);
    if (!response || !response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }

  const $ = cheerio.load(html);
  const candidates: Signal[] = [];

  if (!websiteUrl.toLowerCase().startsWith('https://')) {
    candidates.push({
      type: 'no_https',
      description: 'Site is served over plain HTTP, not HTTPS',
      evidence: websiteUrl,
      strength: 'strong',
    });
  }

  const hasViewportMeta = $('meta[name="viewport"]').length > 0;
  if (!hasViewportMeta) {
    candidates.push({
      type: 'outdated_site',
      description: 'No responsive viewport meta tag found - site likely predates mobile-first design',
      evidence: null,
      strength: 'medium',
    });
  }

  const copyrightYear = extractCopyrightYear($.root().text());
  if (copyrightYear !== null) {
    const staleness = new Date().getFullYear() - copyrightYear;
    if (staleness >= STALE_COPYRIGHT_THRESHOLD_YEARS) {
      candidates.push({
        type: 'outdated_site',
        description: `Footer copyright year (${copyrightYear}) is ${staleness} years stale`,
        evidence: `© ${copyrightYear}`,
        strength: 'medium',
      });
    }
  }

  const hasSchemaOrgMarkup =
    $('[itemtype*="schema.org"]').length > 0 || (html.includes('schema.org') && html.includes('"@context"'));
  if (!hasSchemaOrgMarkup) {
    candidates.push({
      type: 'technical_debt',
      description: 'No schema.org structured data found',
      evidence: null,
      strength: 'weak',
    });
  }

  return strongestSignal(candidates);
}

// Shared marker every "nothing actionable found" fallback description starts
// with - lets `isBaselineSignal` recognize ANY baseline fallback (not just
// `buildNoSignalDetectedFallback`'s) without hardcoding one source's exact
// literal string. `registry-signal.ts`'s `buildRegistrySignal` fallback also
// goes through `buildBaselineFallbackSignal` for this reason.
const BASELINE_FALLBACK_DESCRIPTION_PREFIX = 'No specific signal detected';

/**
 * Builds a generic weak `technical_debt` fallback signal for "nothing
 * notable found, but included via category+geography match" - the shared
 * shape every discovery source's own fallback (see `buildNoSignalDetectedFallback`
 * and `buildRegistrySignal`) is built from, so `isBaselineSignal` has one
 * place to recognize them all. `contextClause` completes the sentence
 * "No specific signal detected <contextClause>; ..." (e.g. "on the site",
 * "in the UK Companies House listing").
 */
export function buildBaselineFallbackSignal(evidence: string | null, contextClause: string): Signal {
  return {
    type: 'technical_debt',
    description: `${BASELINE_FALLBACK_DESCRIPTION_PREFIX} ${contextClause}; included via category+geography match`,
    evidence,
    strength: 'weak',
  };
}

/**
 * Fallback signal used when a website is known to exist but
 * `detectWebsiteSignals` found nothing notable. Keeps `signal` populated
 * (required by the Prospect schema) without overstating the evidence.
 */
export function buildNoSignalDetectedFallback(evidence: string | null): Signal {
  return buildBaselineFallbackSignal(evidence, 'on the site');
}

/**
 * True when `signal` is a baseline/no-signal-detected fallback (see
 * `buildBaselineFallbackSignal`) rather than a genuinely detected signal -
 * recognized by the shared `BASELINE_FALLBACK_DESCRIPTION_PREFIX` marker
 * every fallback's description starts with, not a single hardcoded literal
 * string, so every source's fallback (website-detector, Companies House,
 * Texas Comptroller, ...) is recognized the same way. `evidence` is
 * deliberately ignored, since it varies per call site. Used by
 * `discovery.service.ts`'s thin-prospect filter to identify prospects with
 * nothing actionable beyond "we found a name".
 */
export function isBaselineSignal(signal: Signal): boolean {
  return signal.type === 'technical_debt' && signal.description.startsWith(BASELINE_FALLBACK_DESCRIPTION_PREFIX);
}
