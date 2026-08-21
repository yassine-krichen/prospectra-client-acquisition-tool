import * as cheerio from 'cheerio';

import { closeScrapingSession, launchScrapingSession } from '@/common/scraping/browser';
import { retryOnBlock, ScraperBlockedError } from '@/common/scraping/retry-on-block';
import { buildNoSignalDetectedFallback, detectWebsiteSignals } from '@/features/discovery/signal-detection';
import { extractDomain } from '@/features/discovery/normalize-domain';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';

const INDIE_HACKERS_BASE_URL = 'https://www.indiehackers.com';
const PRODUCTS_URL = `${INDIE_HACKERS_BASE_URL}/products`;
const JOBS_URL = `${INDIE_HACKERS_BASE_URL}/jobs`;

// Indie Hackers has no public API (per the spec), so this scrapes its public
// "Products" (launches) and "Jobs" pages with the same headless-Chromium
// approach as yellowpages.source.ts, then parses the rendered HTML with
// cheerio (rather than Playwright's own `$$eval`) because these pages'
// structure is less uniform. The selectors below are a best-effort read of
// the live site's markup at the time of writing - like yellowpages.source.ts,
// they may need updating if Indie Hackers changes its DOM.
interface ScrapedLaunch {
  name: string | null;
  tagline: string | null;
  productPath: string | null;
  websiteUrl: string | null;
}

interface ScrapedJob {
  title: string | null;
  companyName: string | null;
  jobPath: string | null;
}

async function fetchRenderedHtml(url: string): Promise<string> {
  const session = await launchScrapingSession();

  try {
    const page = await session.context.newPage();
    const response = await page.goto(url, { timeout: 60_000 });
    // A non-2xx response (e.g. a Cloudflare block) still renders as a normal
    // page with zero matching result nodes - without this check that reads
    // as "no results", not "blocked", and the block goes unnoticed. Same
    // pattern as yellowpages.source.ts.
    if (response && !response.ok()) {
      throw new ScraperBlockedError(`${url} returned ${response.status()} ${response.statusText()}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null);
    return await page.content();
  } finally {
    await closeScrapingSession(session);
  }
}

function scrapeLaunches(html: string): ScrapedLaunch[] {
  const $ = cheerio.load(html);
  const launches: ScrapedLaunch[] = [];

  $('a[href^="/product/"]').each((_, element) => {
    const node = $(element);
    // Live indiehackers.com/products (confirmed 2026-08-21) renders two
    // sections under this same `a[href^="/product/"]` link pattern: a "Top
    // Products" ranking widget (`.top-product__*`) and an "All Products"
    // grid (`.product-card__*`) - neither uses a heading tag, so the
    // originally-written `h3, h2` selector matched zero real listings.
    const name =
      node.find('.product-card__name').first().text().trim() ||
      node.find('.top-product__snippet strong').first().text().trim() ||
      null;
    const tagline =
      node.find('.product-card__tagline').first().text().trim() ||
      node.find('.top-product__title span').first().text().trim() ||
      null;
    const productPath = node.attr('href') ?? null;
    const websiteUrl = node.find('a[href^="http"]').first().attr('href') ?? null;

    if (name) launches.push({ name, tagline, productPath, websiteUrl });
  });

  return launches;
}

function scrapeJobs(html: string): ScrapedJob[] {
  const $ = cheerio.load(html);
  const jobs: ScrapedJob[] = [];

  // Live indiehackers.com/jobs (confirmed 2026-08-21) renders each listing as
  // an `a.jobs__job` link to `/post/jobAd-...` (not `/jobs/...`, which never
  // matched anything), with the role under `.job__role` and the hiring
  // product's name under `.job__product-name` - neither the originally
  // written `h3, h2` / `.company-name, [class*="company"]` selectors ever
  // matched this markup.
  $('a.jobs__job').each((_, element) => {
    const node = $(element);
    const title = node.find('.job__role').first().text().trim() || null;
    const companyName = node.find('.job__product-name').first().text().trim() || null;
    const jobPath = node.attr('href') ?? null;

    if (title) jobs.push({ title, companyName, jobPath });
  });

  return jobs;
}

/**
 * Scrapes Indie Hackers' public "Products" (recent launches) and "Jobs"
 * pages. Any discovered external website URL is passed to
 * `detectWebsiteSignals` (which internally uses `fetchSafely`) rather than
 * fetched directly - these URLs come from scraped, attacker-writable page
 * content, same SSRF concern as yellowpages.source.ts.
 */
export async function runIndieHackersSource(_query: DiscoveryQuery): Promise<SourceResult> {
  let launchesHtml: string;
  let jobsHtml: string;
  try {
    [launchesHtml, jobsHtml] = await Promise.all([
      retryOnBlock(() => fetchRenderedHtml(PRODUCTS_URL)),
      retryOnBlock(() => fetchRenderedHtml(JOBS_URL)),
    ]);
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: Indie Hackers scrape failed (${(error as Error).message})`,
    };
  }

  const prospects: DiscoveredProspect[] = [];

  for (const launch of scrapeLaunches(launchesHtml)) {
    if (!launch.name) continue;

    const signal = launch.websiteUrl
      ? ((await detectWebsiteSignals(launch.websiteUrl)) ?? buildNoSignalDetectedFallback(launch.websiteUrl))
      : {
          type: 'new_launch' as const,
          description: 'Recently launched on Indie Hackers',
          evidence: launch.tagline,
          strength: 'strong' as const,
        };

    prospects.push({
      companyName: launch.name,
      domain: extractDomain(launch.websiteUrl),
      websiteUrl: launch.websiteUrl,
      industry: 'saas',
      location: { city: null, country: null, lat: null, lng: null },
      companySize: 'unknown',
      source: 'indiehackers',
      sourceUrl: launch.productPath ? `${INDIE_HACKERS_BASE_URL}${launch.productPath}` : PRODUCTS_URL,
      discoveredAt: new Date(),
      phone: null,
      address: null,
      signal,
    });
  }

  for (const job of scrapeJobs(jobsHtml)) {
    if (!job.title || !job.companyName) continue;

    prospects.push({
      companyName: job.companyName,
      domain: null,
      websiteUrl: null,
      industry: 'saas',
      location: { city: null, country: null, lat: null, lng: null },
      companySize: 'unknown',
      source: 'indiehackers',
      sourceUrl: job.jobPath ? `${INDIE_HACKERS_BASE_URL}${job.jobPath}` : JOBS_URL,
      discoveredAt: new Date(),
      phone: null,
      address: null,
      signal: {
        type: 'hiring_post',
        description: 'Actively hiring, posted on Indie Hackers Jobs',
        evidence: job.title,
        strength: 'medium',
      },
    });
  }

  return { ok: true, prospects };
}
