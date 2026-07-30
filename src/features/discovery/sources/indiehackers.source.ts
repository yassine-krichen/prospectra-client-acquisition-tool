import * as cheerio from 'cheerio';

import { closeScrapingSession, launchScrapingSession } from '@/common/scraping/browser';
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
// the live site's markup at the time of writing — like yellowpages.source.ts,
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
    await page.goto(url, { timeout: 60_000 });
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
    const name = node.find('h3, h2').first().text().trim() || null;
    const tagline = node.find('p').first().text().trim() || null;
    const productPath = node.attr('href') ?? null;
    const websiteUrl = node.find('a[href^="http"]').first().attr('href') ?? null;

    if (name) launches.push({ name, tagline, productPath, websiteUrl });
  });

  return launches;
}

function scrapeJobs(html: string): ScrapedJob[] {
  const $ = cheerio.load(html);
  const jobs: ScrapedJob[] = [];

  $('a[href^="/jobs/"]').each((_, element) => {
    const node = $(element);
    const title = node.find('h3, h2').first().text().trim() || null;
    const companyName = node.find('.company-name, [class*="company"]').first().text().trim() || null;
    const jobPath = node.attr('href') ?? null;

    if (title) jobs.push({ title, companyName, jobPath });
  });

  return jobs;
}

/**
 * Scrapes Indie Hackers' public "Products" (recent launches) and "Jobs"
 * pages. Any discovered external website URL is passed to
 * `detectWebsiteSignals` (which internally uses `fetchSafely`) rather than
 * fetched directly — these URLs come from scraped, attacker-writable page
 * content, same SSRF concern as yellowpages.source.ts.
 */
export async function runIndieHackersSource(_query: DiscoveryQuery): Promise<SourceResult> {
  let launchesHtml: string;
  let jobsHtml: string;
  try {
    [launchesHtml, jobsHtml] = await Promise.all([fetchRenderedHtml(PRODUCTS_URL), fetchRenderedHtml(JOBS_URL)]);
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
