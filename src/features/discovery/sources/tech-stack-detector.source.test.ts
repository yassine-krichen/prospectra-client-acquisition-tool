import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectTechStack } from './tech-stack-detector.source';

// `dns.lookup` is mocked at the module level (see `is-safe-fetch-target.test.ts`
// for why `vi.spyOn` doesn't work here) so the SSRF guard inside `fetchSafely`
// never runs its real DNS resolution against the fake *.example.com hosts
// these fixtures use.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';

const mockLookup = vi.mocked(lookup);

function mockFetchResponse(
  html: string,
  options: { ok?: boolean; headers?: Record<string, string> } = {}
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: options.ok ?? true,
      status: options.ok === false ? 500 : 200,
      headers: new Headers(options.headers ?? {}),
      text: () => Promise.resolve(html),
    })
  );
}

describe('detectTechStack', () => {
  beforeEach(() => {
    mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
  });

  it('returns null websiteUrl skipped entirely without making a network call', async () => {
    const result = await detectTechStack(null);

    expect(result).toEqual({ ok: false, reason: 'source unavailable: no websiteUrl to check' });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('fails closed with a typed reason when the fetch rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await detectTechStack('https://unreachable.example.com');

    expect(result.ok).toBe(false);
  });

  it('fails closed with a typed reason when the response is not ok', async () => {
    mockFetchResponse('<html></html>', { ok: false });

    const result = await detectTechStack('https://broken.example.com');

    expect(result.ok).toBe(false);
  });

  it('reports empty technologies and a null signal when no signatures are found', async () => {
    mockFetchResponse('<html><head></head><body>Hello world</body></html>');

    const result = await detectTechStack('https://plain.example.com');

    expect(result).toEqual({
      ok: true,
      lookup: { domain: 'plain.example.com', technologies: [], signal: null },
    });
  });

  it('detects WordPress from /wp-content/ markers and produces an old_stack signal when no modern framework is present', async () => {
    mockFetchResponse(`
      <html>
        <head></head>
        <body><img src="/wp-content/uploads/logo.png" /></body>
      </html>
    `);

    const result = await detectTechStack('https://wp-site.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toContain('WordPress');
    expect(result.lookup.signal?.type).toBe('old_stack');
  });

  it('extracts a WordPress version from the generator meta tag when present', async () => {
    mockFetchResponse(`
      <html>
        <head><meta name="generator" content="WordPress 6.2" /></head>
        <body></body>
      </html>
    `);

    const result = await detectTechStack('https://wp-versioned.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toContain('WordPress');
    expect(result.lookup.technologies).toContain('WordPress 6.2');
  });

  it('detects WordPress with no extractable version and still records the plain WordPress entry', async () => {
    mockFetchResponse(`
      <html>
        <head></head>
        <body>Powered by wp-json somewhere in the markup</body>
      </html>
    `);

    const result = await detectTechStack('https://wp-noversion.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(['WordPress']);
  });

  it('extracts a jQuery version from a script src and feeds the EOL rule (jQuery 1.x -> strong old_stack signal)', async () => {
    mockFetchResponse(`
      <html>
        <head><script src="/assets/jquery-1.9.1.min.js"></script></head>
        <body></body>
      </html>
    `);

    const result = await detectTechStack('https://legacy-jquery.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toContain('jQuery 1.9.1');
    expect(result.lookup.signal).toEqual({
      type: 'old_stack',
      description: 'jQuery 1.x detected - EOL major version',
      evidence: 'jQuery 1.9.1',
      strength: 'strong',
    });
  });

  it('does not flag a modern jQuery 3.x version as stale', async () => {
    mockFetchResponse(`
      <html>
        <head><script src="/assets/jquery-3.6.0.min.js"></script></head>
        <body></body>
      </html>
    `);

    const result = await detectTechStack('https://modern-jquery.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toContain('jQuery 3.6.0');
    expect(result.lookup.signal).toBeNull();
  });

  it('detects Shopify from cdn.shopify.com markers and records it without fabricating any signal', async () => {
    mockFetchResponse(`
      <html><body><script src="https://cdn.shopify.com/s/files/theme.js"></script></body></html>
    `);

    const result = await detectTechStack('https://shop.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(['Shopify']);
    expect(result.lookup.signal).toBeNull();
  });

  it('detects Shopify from the x-shopify-stage response header', async () => {
    mockFetchResponse('<html><body>Storefront</body></html>', { headers: { 'x-shopify-stage': 'production' } });

    const result = await detectTechStack('https://shop-header.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(['Shopify']);
    expect(result.lookup.signal).toBeNull();
  });

  it('detects Wix from static.wixstatic.com markers and records it without fabricating any signal', async () => {
    mockFetchResponse('<html><body><img src="https://static.wixstatic.com/media/logo.png" /></body></html>');

    const result = await detectTechStack('https://wix-site.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(['Wix']);
    expect(result.lookup.signal).toBeNull();
  });

  it('detects Webflow from a data-wf-site attribute and records it without fabricating any signal', async () => {
    mockFetchResponse('<html><body data-wf-site="abc123"></body></html>');

    const result = await detectTechStack('https://webflow-site.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(['Webflow']);
    expect(result.lookup.signal).toBeNull();
  });

  it('detects Next.js from a __NEXT_DATA__ script tag and records it without fabricating any signal', async () => {
    mockFetchResponse('<html><body><script id="__NEXT_DATA__">{}</script></body></html>');

    const result = await detectTechStack('https://next-site.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(['Next.js']);
    expect(result.lookup.signal).toBeNull();
  });

  it('detects Next.js from the x-powered-by response header', async () => {
    mockFetchResponse('<html><body>Hello</body></html>', { headers: { 'x-powered-by': 'Next.js' } });

    const result = await detectTechStack('https://next-header.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(['Next.js']);
    expect(result.lookup.signal).toBeNull();
  });

  it('records Google Analytics and Meta Pixel as informational technologies without fabricating a signal', async () => {
    mockFetchResponse(`
      <html>
        <head>
          <script>gtag('config', 'UA-XXXX');</script>
          <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
        </head>
        <body></body>
      </html>
    `);

    const result = await detectTechStack('https://tracked-site.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(expect.arrayContaining(['Google Analytics', 'Meta Pixel']));
    expect(result.lookup.signal).toBeNull();
  });

  it('does not let a modern platform found alongside WordPress markers suppress evidence collection, but still only feeds legacy signatures to the rules engine', async () => {
    // WordPress markers alone (no modern JS framework) should still produce
    // an old_stack signal even when an analytics tag is also present -
    // analytics tags are recorded but never consulted by the rules engine.
    mockFetchResponse(`
      <html>
        <head></head>
        <body>
          <script src="/wp-content/themes/x/script.js"></script>
          <script>gtag('config', 'UA-XXXX');</script>
        </body>
      </html>
    `);

    const result = await detectTechStack('https://wp-with-analytics.example.com');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.lookup.technologies).toEqual(expect.arrayContaining(['WordPress', 'Google Analytics']));
    expect(result.lookup.signal?.type).toBe('old_stack');
  });
});
