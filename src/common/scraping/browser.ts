import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright-core';

// Sites like yellowpages.com block plain `fetch()` requests as bot traffic.
// A real headless-Chromium context (with a realistic user agent) reliably
// gets through where a bare HTTP client doesn't. Ported from the Python
// prototype's `sync_playwright()` usage - see the removed
// `app/scraper/yellowpages.py` in git history for the original approach.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Overriding `userAgent` on `newContext` only rewrites the `User-Agent`
// header string - it does NOT touch the `Sec-CH-UA*` Client Hints headers,
// which Playwright's bundled Chromium generates automatically from its real
// underlying build and brand ("HeadlessChrome"), independent of the spoofed
// UA string. Confirmed live 2026-08-21: every request was sending
// `sec-ch-ua: "HeadlessChrome";v="149", ...` in plaintext even after the
// navigator.webdriver/AutomationControlled fix - and yellowpages.com's
// Cloudflare zone explicitly requests these headers (`accept-ch`/`critical-ch`
// list the full Sec-CH-UA-* family in its responses), so this was a direct,
// edge-readable admission of automation on every request. These values must
// stay consistent with DEFAULT_USER_AGENT's claimed Chrome version above.
const CLIENT_HINTS_HEADERS = {
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

export interface ScrapingSession {
  browser: Browser;
  context: BrowserContext;
}

// Vercel (and AWS Lambda generally) run functions on Amazon Linux with no
// Chromium binary available at all - the full `playwright` package's own
// ~300MB+ download can't ship inside a serverless function bundle, which is
// what used to fail at runtime with "Cannot find module
// .../playwright-core/browsers.json" (playwright-core looking for a browser
// that was never there). `@sparticuz/chromium` ships a Lambda-compiled,
// brotli-compressed Chromium build sized to actually fit. Locally, none of
// this runs - `chromium.launch()` finds the Chromium the full `playwright`
// package (a devDependency purely for this) downloads to the shared
// Playwright browser cache on `npm install`/`npx playwright install`, which
// `playwright-core` resolves the same way without needing its own copy.
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * Exported (rather than inlined into `launchScrapingSession`) purely so a
 * test can exercise both branches without actually launching a browser.
 */
export async function resolveLaunchOptions(isServerless: boolean = IS_SERVERLESS): Promise<LaunchOptions> {
  const baseArgs = ['--disable-blink-features=AutomationControlled'];

  if (!isServerless) {
    return { headless: true, args: baseArgs };
  }

  const sparticuzChromium = (await import('@sparticuz/chromium')).default;
  return {
    headless: true,
    executablePath: await sparticuzChromium.executablePath(),
    args: [...sparticuzChromium.args, ...baseArgs],
  };
}

/**
 * Launches a headless Chromium browser + context configured to look like a
 * normal desktop browser. Callers are responsible for calling
 * `closeScrapingSession` when done (typically in a `finally` block).
 *
 * Cloudflare-protected sites (confirmed live against yellowpages.com,
 * 2026-08-21) hard-block plain headless Chromium with a 403 "Sorry, you have
 * been blocked" page - even with a realistic user agent - because headless
 * Chromium otherwise exposes itself via `navigator.webdriver` and the
 * `AutomationControlled` blink feature. That block returns a normal 200-shaped
 * page with zero matching result nodes, so a scraper that doesn't check the
 * response status silently reports "no results" instead of "blocked" - this
 * is exactly what was happening here. Disabling the `AutomationControlled`
 * blink feature and overriding `navigator.webdriver` back to `undefined` is
 * enough to pass Cloudflare's check while staying fully headless (confirmed
 * live: 403/0 results before, 200/36 results after) - no display/xvfb
 * required, so this still works on a headless server.
 *
 * Note (2026-08-21): this is a mitigation, not a guarantee. Cloudflare's bot
 * score also weighs the TLS/JA3-JA4 fingerprint of the real Chromium binary
 * and IP/session reputation built up over repeated requests - neither is
 * spoofable from here. Expect this to still get challenged/blocked
 * intermittently (403, or a harder edge-side block on a flagged IP), not to
 * pass 100% of the time.
 */
export async function launchScrapingSession(): Promise<ScrapingSession> {
  const browser = await chromium.launch(await resolveLaunchOptions());
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    extraHTTPHeaders: CLIENT_HINTS_HEADERS,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, context };
}

export async function closeScrapingSession(session: ScrapingSession): Promise<void> {
  await session.browser.close();
}
