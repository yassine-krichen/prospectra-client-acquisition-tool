import { describe, expect, it } from 'vitest';

import { getClientIp, parseUserAgent } from './request-metadata';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const EDGE_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/login', { headers });
}

describe('getClientIp', () => {
  it('returns the first address from x-forwarded-for', () => {
    expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    expect(getClientIp(requestWithHeaders({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('returns null when neither header is present', () => {
    expect(getClientIp(requestWithHeaders({}))).toBeNull();
  });
});

describe('parseUserAgent', () => {
  it('identifies Chrome on Windows', () => {
    expect(parseUserAgent(CHROME_WINDOWS)).toEqual({ browser: 'Chrome', device: 'Windows' });
  });

  it('identifies Safari on Mac', () => {
    expect(parseUserAgent(SAFARI_MAC)).toEqual({ browser: 'Safari', device: 'Mac' });
  });

  it('identifies Firefox on Linux', () => {
    expect(parseUserAgent(FIREFOX_LINUX)).toEqual({ browser: 'Firefox', device: 'Linux' });
  });

  it('identifies Safari on iPhone', () => {
    expect(parseUserAgent(SAFARI_IPHONE)).toEqual({ browser: 'Safari', device: 'iPhone' });
  });

  it('identifies Edge before falling through to the Chrome pattern it also matches', () => {
    expect(parseUserAgent(EDGE_WINDOWS)).toEqual({ browser: 'Edge', device: 'Windows' });
  });

  it('returns Unknown/Unknown for a null or unrecognized user agent', () => {
    expect(parseUserAgent(null)).toEqual({ browser: 'Unknown', device: 'Unknown' });
    expect(parseUserAgent('some-custom-bot/1.0')).toEqual({ browser: 'Unknown', device: 'Unknown' });
  });
});
