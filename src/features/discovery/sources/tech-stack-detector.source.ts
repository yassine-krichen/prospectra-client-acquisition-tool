import * as cheerio from 'cheerio';

import { fetchSafely } from '@/common/net/is-safe-fetch-target';
import { detectStaleStackSignal } from '@/features/discovery/stale-stack-rules';
import type { StaleStackResult } from '@/features/discovery/sources/builtwith.source';
import type { Signal } from '@/features/prospects/prospect.types';

// First-party, no-API-key tech-stack detector: a single HTTP fetch of a
// prospect's homepage, checked for the same kind of CMS/framework/analytics
// signatures BuiltWith's paid API would report. Feeds the exact same
// `detectStaleStackSignal` rules table BuiltWith already uses (see
// builtwith.source.ts) rather than building a parallel rules engine, so this
// runs *before* BuiltWith in the enrichment chain and BuiltWith becomes a
// secondary cross-check rather than the primary tech-stack source.

const JQUERY_SCRIPT_PATTERN = /jquery-(\d+\.\d+\.\d+)(?:\.min)?\.js/i;
const WORDPRESS_GENERATOR_VERSION_PATTERN = /WordPress\s*([\d.]+)/i;

/**
 * Detects CMS/framework/analytics signatures from a single homepage fetch.
 * Only the WordPress/jQuery-type signatures ("legacy stack, no modern layer")
 * are passed through `detectStaleStackSignal` to potentially produce an
 * `old_stack` signal. Modern-platform signatures (Shopify/Wix/Webflow/
 * Next.js) and analytics tags are evidence of a healthy/modern stack - they
 * are recorded in the returned `technologies` list for visibility/debugging
 * only, never used to fabricate a signal (this codebase never invents a
 * signal just because a caller "needs" one - see signal-detection.ts).
 */
export async function detectTechStack(websiteUrl: string | null): Promise<StaleStackResult> {
  if (!websiteUrl) {
    return { ok: false, reason: 'source unavailable: no websiteUrl to check' };
  }

  let hostname: string;
  try {
    hostname = new URL(websiteUrl).hostname;
  } catch {
    hostname = websiteUrl;
  }

  let html: string;
  let response: Response;
  try {
    // `websiteUrl` comes from scraped/attacker-writable sources, so it's
    // validated - and every redirect hop re-validated - against private/
    // loopback/link-local targets before being fetched. See `fetchSafely`.
    const fetched = await fetchSafely(websiteUrl);
    if (!fetched || !fetched.ok) {
      return { ok: false, reason: 'source unavailable: tech stack detector could not fetch the homepage' };
    }
    response = fetched;
    html = await response.text();
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: tech stack detector request failed (${(error as Error).message})`,
    };
  }

  const $ = cheerio.load(html);
  const generatorContent = $('meta[name="generator"]').attr('content') ?? '';
  const technologies: string[] = [];

  const hasWordPressMarkers =
    /\/wp-content\//i.test(html) ||
    /\/wp-includes\//i.test(html) ||
    /wp-json/i.test(html) ||
    /wordpress/i.test(generatorContent);
  if (hasWordPressMarkers) {
    technologies.push('WordPress');
    const versionMatch = generatorContent.match(WORDPRESS_GENERATOR_VERSION_PATTERN);
    if (versionMatch) technologies.push(`WordPress ${versionMatch[1]}`);
  }

  const jqueryMatch = html.match(JQUERY_SCRIPT_PATTERN);
  if (jqueryMatch) technologies.push(`jQuery ${jqueryMatch[1]}`);

  // Modern-platform signatures - recorded for visibility only, see the doc
  // comment above.
  const hasShopifyMarkers =
    /cdn\.shopify\.com/i.test(html) || /Shopify\.theme/i.test(html) || response.headers.get('x-shopify-stage') !== null;
  if (hasShopifyMarkers) technologies.push('Shopify');

  const hasWixMarkers = /static\.wixstatic\.com/i.test(html) || /wix\.com/i.test(generatorContent);
  if (hasWixMarkers) technologies.push('Wix');

  const hasWebflowMarkers = /webflow\.js/i.test(html) || /data-wf-site/i.test(html);
  if (hasWebflowMarkers) technologies.push('Webflow');

  const hasNextJsMarkers =
    /__NEXT_DATA__/.test(html) || (response.headers.get('x-powered-by') ?? '').toLowerCase() === 'next.js';
  if (hasNextJsMarkers) technologies.push('Next.js');

  if (/gtag\(/i.test(html) || /googletagmanager\.com/i.test(html)) technologies.push('Google Analytics');
  if (/fbevents\.js/i.test(html)) technologies.push('Meta Pixel');

  // Deliberate asymmetry: only the legacy-stack-type signatures feed the
  // rules table, so a modern platform's mere presence can never trigger an
  // `old_stack` signal.
  const legacySignatures = technologies.filter((tech) => /wordpress/i.test(tech) || /jquery/i.test(tech));
  const match = detectStaleStackSignal(legacySignatures);
  const signal: Signal | null = match
    ? {
        type: 'old_stack',
        description: match.description,
        evidence: technologies.length > 0 ? technologies.join(', ') : null,
        strength: match.strength,
      }
    : null;

  return { ok: true, lookup: { domain: hostname, technologies, signal } };
}
