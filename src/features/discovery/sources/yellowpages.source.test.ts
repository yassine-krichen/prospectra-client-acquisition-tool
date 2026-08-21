import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractListingsFromPage } from './yellowpages.source';

const fixtureHtml = readFileSync(
  fileURLToPath(new URL('./__fixtures__/yellowpages-search-results.html', import.meta.url)),
  'utf-8'
);

// Captured live from a real yellowpages.com/search results page
// (category=plumber, geography=Austin, TX) on 2026-08-21 - genuine result
// rows, not a Cloudflare block page. Locks in today's known-good selectors
// in `extractListingsFromPage` so a future DOM change on the live site shows
// up as a local test failure instead of a silent "0 found".
describe('extractListingsFromPage', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent(fixtureHtml);
  });

  afterAll(async () => {
    await browser.close();
  });

  it('extracts every real listing row from the fixture', async () => {
    const listings = await extractListingsFromPage(page);

    expect(listings.length).toBe(36);
  });

  it('extracts name, phone, address, and website for a listing that has a website', async () => {
    const listings = await extractListingsFromPage(page);

    expect(listings).toContainEqual({
      name: 'Clarke Kent Plumbing',
      phone: '(512) 766-0970',
      address: '1408 W Ben White Blvd, Austin, TX 78704',
      website: 'http://www.clarkekentplumbing.com/',
    });
  });

  it('extracts a listing with a null website when the result has none listed', async () => {
    const listings = await extractListingsFromPage(page);

    expect(listings).toContainEqual({
      name: 'Best Home Savings',
      phone: '(855) 566-6978',
      address: 'Serving the Austin area.',
      website: null,
    });
  });
});
