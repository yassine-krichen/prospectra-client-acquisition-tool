import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const productsFixtureHtml = readFileSync(
  fileURLToPath(new URL('./__fixtures__/indiehackers-products.html', import.meta.url)),
  'utf-8'
);
const jobsFixtureHtml = readFileSync(
  fileURLToPath(new URL('./__fixtures__/indiehackers-jobs.html', import.meta.url)),
  'utf-8'
);
const EMPTY_HTML = '<html><body></body></html>';

// Tests that only care about Products leave this at its default (empty page)
// so the jobs half of `runIndieHackersSource` contributes nothing; the jobs
// fixture test below points it at the real captured jobs page instead.
let currentJobsHtml = EMPTY_HTML;

// `fetchRenderedHtml` (the fetch/render boundary in indiehackers.source.ts)
// goes through `launchScrapingSession`/`closeScrapingSession` - mocking that
// module lets this test drive the real parsing logic (`scrapeLaunches`,
// `scrapeJobs`, and the rest of `runIndieHackersSource`) against static
// fixtures instead of a real browser or network request.
function createFakePage() {
  let requestedUrl = '';
  return {
    goto: vi.fn(async (url: string) => {
      requestedUrl = url;
      return { ok: () => true, status: () => 200, statusText: () => 'OK' };
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    content: vi.fn(async () => (requestedUrl.includes('/jobs') ? currentJobsHtml : productsFixtureHtml)),
  };
}

vi.mock('@/common/scraping/browser', () => ({
  launchScrapingSession: vi.fn(async () => ({
    browser: {},
    context: { newPage: async () => createFakePage() },
  })),
  closeScrapingSession: vi.fn(async () => undefined),
}));

import { runIndieHackersSource } from './indiehackers.source';

const query = { category: 'saas', geography: 'ignored' };

describe('runIndieHackersSource', () => {
  beforeEach(() => {
    currentJobsHtml = EMPTY_HTML;
  });

  it('extracts every real product launch from the fixture (captured live 2026-08-21, not a block page)', async () => {
    const result = await runIndieHackersSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toHaveLength(23);
  });

  it('maps a real launch to a prospect with a new_launch signal when it has no discoverable website', async () => {
    const result = await runIndieHackersSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toContainEqual(
      expect.objectContaining({
        companyName: 'Human Benchmark',
        domain: null,
        websiteUrl: null,
        source: 'indiehackers',
        sourceUrl: 'https://www.indiehackers.com/product/human-benchmark',
        signal: expect.objectContaining({
          type: 'new_launch',
          description: 'Recently launched on Indie Hackers',
          evidence: "Quantify and improve your brain's performance in real time",
        }),
      })
    );
  });

  it('extracts every real job listing from the fixture (captured live 2026-08-21, not a block page)', async () => {
    currentJobsHtml = jobsFixtureHtml;

    const result = await runIndieHackersSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    // 23 product launches + 30 real job listings from the fixture.
    expect(result.prospects).toHaveLength(53);
  });

  it('maps a real job listing to a prospect with a hiring_post signal', async () => {
    currentJobsHtml = jobsFixtureHtml;

    const result = await runIndieHackersSource(query);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.prospects).toContainEqual(
      expect.objectContaining({
        companyName: 'VidSyndicate',
        domain: null,
        websiteUrl: null,
        source: 'indiehackers',
        sourceUrl: 'https://www.indiehackers.com/post/jobAd-9758cc6f2a',
        signal: expect.objectContaining({
          type: 'hiring_post',
          description: 'Actively hiring, posted on Indie Hackers Jobs',
          evidence: 'Beta Testers',
          strength: 'medium',
        }),
      })
    );
  });
});
