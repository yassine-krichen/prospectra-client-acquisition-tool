import { chromium, type Browser, type BrowserContext } from 'playwright';

// Sites like yellowpages.com block plain `fetch()` requests as bot traffic.
// A real headless-Chromium context (with a realistic user agent) reliably
// gets through where a bare HTTP client doesn't. Ported from the Python
// prototype's `sync_playwright()` usage - see the removed
// `app/scraper/yellowpages.py` in git history for the original approach.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface ScrapingSession {
  browser: Browser;
  context: BrowserContext;
}

/**
 * Launches a headless Chromium browser + context configured to look like a
 * normal desktop browser. Callers are responsible for calling
 * `closeScrapingSession` when done (typically in a `finally` block).
 */
export async function launchScrapingSession(): Promise<ScrapingSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT });
  return { browser, context };
}

export async function closeScrapingSession(session: ScrapingSession): Promise<void> {
  await session.browser.close();
}
