import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildNoSignalDetectedFallback, detectWebsiteSignals } from './signal-detection';

// `dns.lookup` is mocked at the module level (see `is-safe-fetch-target.test.ts`
// for why `vi.spyOn` doesn't work here) so the SSRF guard's real DNS
// resolution never runs against the fake *.example.com hosts these fixtures use.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';

const mockLookup = vi.mocked(lookup);

// Every fixture below is fetched through a mocked `fetch` - this is the
// appropriate boundary to mock, since `detectWebsiteSignals` exists
// specifically to make a real network call.
function mockFetchResponse(html: string, options: { ok?: boolean } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: options.ok ?? true,
      text: () => Promise.resolve(html),
    })
  );
}

const currentYear = new Date().getFullYear();

function modernSiteHtml(year: number): string {
  return `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>
      </head>
      <body>© ${year} Example Inc.</body>
    </html>
  `;
}

function legacySiteHtml(year: number): string {
  return `
    <html>
      <head></head>
      <body>Copyright ${year} Old Co. All rights reserved.</body>
    </html>
  `;
}

describe('detectWebsiteSignals', () => {
  // `detectWebsiteSignals` now resolves the hostname before fetching (SSRF
  // guard). Every test in this suite fetches from a fake *.example.com host,
  // so DNS resolution is stubbed to a public IP by default - the SSRF-guard
  // tests further down override this per-test to exercise the guard itself.
  beforeEach(() => {
    mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockLookup.mockReset();
  });

  it('returns null for a fully modern site (https, viewport meta, current-year copyright, schema.org)', async () => {
    mockFetchResponse(modernSiteHtml(currentYear));

    const signal = await detectWebsiteSignals('https://modern-site.example.com');

    expect(signal).toBeNull();
  });

  it('flags no_https as strong when the url is not served over https, even if the page otherwise looks modern', async () => {
    mockFetchResponse(modernSiteHtml(currentYear));

    const signal = await detectWebsiteSignals('http://modern-site.example.com');

    expect(signal).toEqual({
      type: 'no_https',
      description: 'Site is served over plain HTTP, not HTTPS',
      evidence: 'http://modern-site.example.com',
      strength: 'strong',
    });
  });

  it('flags no_https as the strongest signal when a legacy http site also lacks viewport, has a stale copyright, and no schema.org markup', async () => {
    mockFetchResponse(legacySiteHtml(currentYear - 10));

    const signal = await detectWebsiteSignals('http://legacy-site.example.com');

    expect(signal?.type).toBe('no_https');
    expect(signal?.strength).toBe('strong');
  });

  it('flags a missing viewport meta tag as a medium outdated_site signal on an otherwise-modern https site', async () => {
    mockFetchResponse(`
      <html>
        <head>
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>
        </head>
        <body>© ${currentYear} Example Inc.</body>
      </html>
    `);

    const signal = await detectWebsiteSignals('https://no-viewport.example.com');

    expect(signal?.type).toBe('outdated_site');
    expect(signal?.strength).toBe('medium');
    expect(signal?.description).toMatch(/viewport/i);
  });

  it('flags a stale copyright year as a medium outdated_site signal on an https site with a viewport tag but no schema.org markup', async () => {
    const staleYear = currentYear - 3;
    mockFetchResponse(`
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
        <body>© ${staleYear} Example Inc.</body>
      </html>
    `);

    const signal = await detectWebsiteSignals('https://stale-copyright.example.com');

    expect(signal?.type).toBe('outdated_site');
    expect(signal?.strength).toBe('medium');
    expect(signal?.evidence).toBe(`© ${staleYear}`);
  });

  it('does not flag a copyright year that is only two years stale (below the 3-year threshold)', async () => {
    const almostStaleYear = currentYear - 2;
    mockFetchResponse(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>
        </head>
        <body>© ${almostStaleYear} Example Inc.</body>
      </html>
    `);

    const signal = await detectWebsiteSignals('https://recent-copyright.example.com');

    expect(signal).toBeNull();
  });

  it('flags missing schema.org markup as the weakest technical_debt signal when nothing else looks stale', async () => {
    mockFetchResponse(`
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
        <body>© ${currentYear} Example Inc.</body>
      </html>
    `);

    const signal = await detectWebsiteSignals('https://no-schema.example.com');

    expect(signal?.type).toBe('technical_debt');
    expect(signal?.strength).toBe('weak');
  });

  it('recognizes copyright notices in "(c)" and word "copyright" form, not just the © symbol', async () => {
    mockFetchResponse(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"}</script>
        </head>
        <body>Copyright ${currentYear - 5} Old Co.</body>
      </html>
    `);

    const signal = await detectWebsiteSignals('https://text-copyright.example.com');

    expect(signal?.type).toBe('outdated_site');
    expect(signal?.strength).toBe('medium');
  });

  it('recognizes schema.org markup expressed via an itemtype attribute instead of a JSON-LD script', async () => {
    mockFetchResponse(`
      <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
        <body itemscope itemtype="https://schema.org/LocalBusiness">© ${currentYear} Example Inc.</body>
      </html>
    `);

    const signal = await detectWebsiteSignals('https://microdata-schema.example.com');

    expect(signal).toBeNull();
  });

  it('fails closed and returns null instead of throwing when fetch rejects (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    );

    const signal = await detectWebsiteSignals('https://unreachable.example.com');

    expect(signal).toBeNull();
  });

  it('fails closed and returns null instead of claiming the site is fine when the response is not ok', async () => {
    mockFetchResponse('<html></html>', { ok: false });

    const signal = await detectWebsiteSignals('https://broken.example.com');

    expect(signal).toBeNull();
  });

  describe('SSRF guard', () => {
    it('fails closed and returns null for a url resolving to loopback (127.0.0.1)', async () => {
      mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });
      mockFetchResponse(modernSiteHtml(currentYear));

      const signal = await detectWebsiteSignals('http://localhost/');

      expect(signal).toBeNull();
    });

    it('fails closed and returns null for a url resolving to the cloud metadata address (169.254.169.254)', async () => {
      mockLookup.mockResolvedValue({ address: '169.254.169.254', family: 4 });
      mockFetchResponse(modernSiteHtml(currentYear));

      const signal = await detectWebsiteSignals('http://metadata.example.com/latest/meta-data');

      expect(signal).toBeNull();
    });

    it('fails closed and returns null for a url resolving to an RFC 1918 10.x address', async () => {
      mockLookup.mockResolvedValue({ address: '10.1.2.3', family: 4 });
      mockFetchResponse(modernSiteHtml(currentYear));

      const signal = await detectWebsiteSignals('http://internal.example.com/');

      expect(signal).toBeNull();
    });

    it('fails closed and returns null for a url resolving to an RFC 1918 192.168.x address', async () => {
      mockLookup.mockResolvedValue({ address: '192.168.0.10', family: 4 });
      mockFetchResponse(modernSiteHtml(currentYear));

      const signal = await detectWebsiteSignals('http://router.example.com/admin');

      expect(signal).toBeNull();
    });

    it('still detects signals normally for a public https url once the DNS guard passes (unaffected by the guard)', async () => {
      mockFetchResponse(modernSiteHtml(currentYear));

      const signal = await detectWebsiteSignals('https://modern-site.example.com');

      expect(signal).toBeNull();
    });

    it('fails closed and returns null when an initially-safe url redirects to a private IP target', async () => {
      mockLookup
        .mockResolvedValueOnce({ address: '93.184.216.34', family: 4 })
        .mockResolvedValueOnce({ address: '10.0.0.5', family: 4 });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          status: 302,
          headers: new Headers({ location: 'http://internal.example.com/secret' }),
        })
      );

      const signal = await detectWebsiteSignals('https://redirector.example.com/');

      expect(signal).toBeNull();
      expect(mockLookup).toHaveBeenCalledTimes(2);
    });
  });
});

describe('buildNoSignalDetectedFallback', () => {
  it('returns a weak technical_debt signal carrying the provided evidence', () => {
    const fallback = buildNoSignalDetectedFallback('https://example.com');

    expect(fallback.type).toBe('technical_debt');
    expect(fallback.strength).toBe('weak');
    expect(fallback.evidence).toBe('https://example.com');
  });

  it('accepts a null evidence value', () => {
    const fallback = buildNoSignalDetectedFallback(null);

    expect(fallback.evidence).toBeNull();
  });
});
