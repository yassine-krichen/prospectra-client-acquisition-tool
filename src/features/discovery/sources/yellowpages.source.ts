import type { Page } from 'playwright';

import { closeScrapingSession, launchScrapingSession } from '@/common/scraping/browser';
import { retryOnBlock, ScraperBlockedError } from '@/common/scraping/retry-on-block';
import { buildNoSignalDetectedFallback, detectWebsiteSignals } from '@/features/discovery/signal-detection';
import { extractDomain } from '@/features/discovery/normalize-domain';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';

const YELLOWPAGES_BASE_URL = 'https://www.yellowpages.com';
const RESULT_SELECTOR = 'div.result';

// Optional bonus source (not one of the spec's three official Branch A
// sources - Google Places + BuiltWith are). Ported from the Python
// prototype's BeautifulSoup-by-CSS-class parsing (see removed
// `app/scraper/yellowpages.py` in git history) to Playwright's in-page DOM
// evaluation, which serves the same purpose here.
interface ScrapedListing {
  name: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
}

/**
 * Runs the actual listing-extraction `$$eval` against an already-loaded
 * page. Split out from `scrapeListings` so
 * `yellowpages.source.test.ts` can exercise these exact selectors against a
 * static fixture (via `page.setContent`) without touching the network.
 */
export async function extractListingsFromPage(page: Page): Promise<ScrapedListing[]> {
  return page.$$eval(RESULT_SELECTOR, (nodes) =>
    nodes.map((node) => {
      const name = node.querySelector('a.business-name')?.textContent?.trim() ?? null;

      const phoneNode = node.querySelector('div.phones.phone.primary') ?? node.querySelector('div.phone');
      const phone = phoneNode?.textContent?.trim() ?? null;

      const street = node.querySelector('div.street-address')?.textContent?.trim();
      const locality = node.querySelector('div.locality')?.textContent?.trim();
      const adr = node.querySelector('p.adr')?.textContent?.trim();
      const address = street && locality ? `${street}, ${locality}` : (adr ?? null);

      const websiteLink = Array.from(node.querySelectorAll('a')).find(
        (link) =>
          (link.textContent ?? '').toLowerCase().includes('website') &&
          (link.getAttribute('href') ?? '').startsWith('http') &&
          link.getAttribute('target') === '_blank'
      );
      const website = websiteLink?.getAttribute('href') ?? null;

      return { name, phone, address, website };
    })
  );
}

async function scrapeListings(searchUrl: string): Promise<ScrapedListing[]> {
  const session = await launchScrapingSession();

  try {
    const page = await session.context.newPage();
    const response = await page.goto(searchUrl, { timeout: 60_000 });
    // A non-2xx response (e.g. Cloudflare's 403 "you have been blocked" page,
    // confirmed live against yellowpages.com 2026-08-21) still renders as a
    // normal page with zero matching result nodes - without this check that
    // reads as "no results", not "blocked", and the block goes unnoticed.
    if (response && !response.ok()) {
      throw new ScraperBlockedError(`yellowpages.com returned ${response.status()} ${response.statusText()}`);
    }
    // The page may render zero results legitimately (no matches for the
    // query) - don't treat a missing selector as a hard failure.
    await page.waitForSelector(RESULT_SELECTOR, { timeout: 10_000 }).catch(() => null);

    return await extractListingsFromPage(page);
  } finally {
    await closeScrapingSession(session);
  }
}

/**
 * Scrapes yellowpages.com search results for a category + geography query.
 * Maps each listing to a partial Prospect shape and runs
 * `signal-detection.ts` against any discovered website (or flags a
 * `no_website` signal when there isn't one).
 */
export async function runYellowPagesSource(query: DiscoveryQuery): Promise<SourceResult> {
  const searchUrl = `${YELLOWPAGES_BASE_URL}/search?search_terms=${encodeURIComponent(
    query.category
  )}&geo_location_terms=${encodeURIComponent(query.geography)}`;

  let listings: ScrapedListing[];
  try {
    listings = await retryOnBlock(() => scrapeListings(searchUrl));
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: yellowpages scrape failed (${(error as Error).message})`,
    };
  }

  const prospects: DiscoveredProspect[] = [];
  for (const listing of listings) {
    if (!listing.name) continue;

    const signal = listing.website
      ? ((await detectWebsiteSignals(listing.website)) ?? buildNoSignalDetectedFallback(listing.website))
      : { type: 'no_website' as const, description: 'No website listed on yellowpages.com', evidence: null, strength: 'strong' as const };

    prospects.push({
      companyName: listing.name,
      domain: extractDomain(listing.website),
      websiteUrl: listing.website,
      // yellowpages listings are inherently local/SMB businesses.
      industry: 'local_service',
      location: { city: query.geography, country: null, lat: null, lng: null },
      companySize: 'unknown',
      source: 'yellowpages',
      sourceUrl: searchUrl,
      discoveredAt: new Date(),
      phone: listing.phone,
      address: listing.address,
      corroboratingSourceCount: 1,
      signal,
    });
  }

  return { ok: true, prospects };
}
