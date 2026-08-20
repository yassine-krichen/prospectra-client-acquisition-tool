import { afterEach, describe, expect, it, vi } from 'vitest';

// `dns.lookup` is a real network/OS call - mocked at the module level so
// every test controls exactly what a hostname "resolves" to, the same
// boundary `signal-detection.test.ts` mocks `fetch` at.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';

import { fetchSafely, isSafeFetchTarget } from './is-safe-fetch-target';

const mockLookup = vi.mocked(lookup);

describe('isSafeFetchTarget', () => {
  afterEach(() => {
    mockLookup.mockReset();
  });

  it('rejects a non-http(s) scheme', async () => {
    expect(await isSafeFetchTarget('file:///etc/passwd')).toBe(false);
  });

  it('rejects an unparseable url', async () => {
    expect(await isSafeFetchTarget('not a url')).toBe(false);
  });

  it('rejects a url whose hostname resolves to loopback (127.0.0.1)', async () => {
    mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });

    expect(await isSafeFetchTarget('http://localhost/admin')).toBe(false);
  });

  it('rejects a url whose hostname resolves to the cloud metadata address (169.254.169.254)', async () => {
    mockLookup.mockResolvedValue({ address: '169.254.169.254', family: 4 });

    expect(await isSafeFetchTarget('http://metadata.example.com')).toBe(false);
  });

  it('rejects a url whose hostname resolves to an RFC 1918 10.x address', async () => {
    mockLookup.mockResolvedValue({ address: '10.0.0.5', family: 4 });

    expect(await isSafeFetchTarget('http://internal.example.com')).toBe(false);
  });

  it('rejects a url whose hostname resolves to an RFC 1918 192.168.x address', async () => {
    mockLookup.mockResolvedValue({ address: '192.168.1.1', family: 4 });

    expect(await isSafeFetchTarget('http://router.example.com')).toBe(false);
  });

  it('rejects a url whose hostname resolves to IPv6 loopback (::1)', async () => {
    mockLookup.mockResolvedValue({ address: '::1', family: 6 });

    expect(await isSafeFetchTarget('http://localhost6.example.com')).toBe(false);
  });

  it('rejects a url whose DNS lookup fails', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));

    expect(await isSafeFetchTarget('http://nonexistent.example.com')).toBe(false);
  });

  it('accepts a normal public https url resolving to a public IP', async () => {
    mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });

    expect(await isSafeFetchTarget('https://example.com')).toBe(true);
  });
});

describe('fetchSafely', () => {
  afterEach(() => {
    mockLookup.mockReset();
    vi.unstubAllGlobals();
  });

  it('returns null without fetching when the initial url is unsafe', async () => {
    mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSafely('http://127.0.0.1/admin');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a safe redirect to another safe public target', async () => {
    mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 301,
        headers: new Headers({ location: 'https://example.com/final' }),
      })
      .mockResolvedValueOnce({ status: 200, ok: true, text: () => Promise.resolve('ok') });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSafely('https://example.com/start');

    expect(result?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect that points at a private IP target', async () => {
    mockLookup
      .mockResolvedValueOnce({ address: '93.184.216.34', family: 4 })
      .mockResolvedValueOnce({ address: '10.0.0.5', family: 4 });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: 'http://internal.example.com/secret' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSafely('https://example.com/start');

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });
});
