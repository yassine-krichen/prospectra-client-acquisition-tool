import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Guards against SSRF when a URL comes from attacker-writable data (e.g. a
// scraped listing's "website" field). Anyone can set that field to
// http://169.254.169.254/... (cloud metadata) or http://localhost:PORT/admin,
// so every such URL must be validated — including every hop of a redirect —
// before it's ever fetched.

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

interface IpRange {
  base: number[];
  prefixLength: number;
}

// IPv4 ranges are reserved/private per RFC 1918, RFC 3927, RFC 5735, etc.
const BLOCKED_IPV4_RANGES: IpRange[] = [
  { base: [10, 0, 0, 0], prefixLength: 8 }, // RFC 1918 private
  { base: [172, 16, 0, 0], prefixLength: 12 }, // RFC 1918 private
  { base: [192, 168, 0, 0], prefixLength: 16 }, // RFC 1918 private
  { base: [127, 0, 0, 0], prefixLength: 8 }, // loopback
  { base: [169, 254, 0, 0], prefixLength: 16 }, // link-local (includes cloud metadata IP)
  { base: [0, 0, 0, 0], prefixLength: 8 }, // "this network"
  { base: [100, 64, 0, 0], prefixLength: 10 }, // carrier-grade NAT
  { base: [192, 0, 0, 0], prefixLength: 24 }, // IETF protocol assignments
  { base: [192, 0, 2, 0], prefixLength: 24 }, // TEST-NET-1
  { base: [198, 18, 0, 0], prefixLength: 15 }, // benchmarking
  { base: [198, 51, 100, 0], prefixLength: 24 }, // TEST-NET-2
  { base: [203, 0, 113, 0], prefixLength: 24 }, // TEST-NET-3
  { base: [224, 0, 0, 0], prefixLength: 4 }, // multicast
  { base: [240, 0, 0, 0], prefixLength: 4 }, // reserved
  { base: [255, 255, 255, 255], prefixLength: 32 }, // broadcast
];

function ipv4ToInt(octets: number[]): number {
  return octets.reduce((acc, octet) => acc * 256 + octet, 0);
}

function isIpv4InRange(address: string, range: IpRange): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isFinite(octet))) return false;

  const mask = range.prefixLength === 0 ? 0 : (0xffffffff << (32 - range.prefixLength)) >>> 0;
  return (ipv4ToInt(octets) & mask) === (ipv4ToInt(range.base) & mask);
}

function isBlockedIpv4(address: string): boolean {
  return BLOCKED_IPV4_RANGES.some((range) => isIpv4InRange(address, range));
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();

  // ::1 loopback, fe80::/10 link-local, fc00::/7 unique local, ::ffff:0:0/96
  // IPv4-mapped addresses (re-checked as their embedded IPv4 form).
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe8') || normalized.startsWith('fe9')) return true;
  if (normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4[1]);

  return false;
}

/**
 * Rejects an IP address if it falls in a private/loopback/link-local/reserved
 * range — the ranges an attacker-supplied URL could use to reach internal
 * infrastructure or the cloud metadata endpoint.
 */
function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true; // Not a recognizable IP — fail closed.
}

/**
 * Validates a single URL as a safe fetch target: only `http`/`https`
 * schemes, and the hostname must not resolve to a private/loopback/
 * link-local/reserved IP address. Does not follow redirects — callers
 * fetching with redirects must re-validate each hop's URL with this same
 * function (see `fetchSafely`).
 */
export async function isSafeFetchTarget(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;

  try {
    const { address } = await dnsLookup(parsed.hostname);
    return !isBlockedIpAddress(address);
  } catch {
    return false; // DNS resolution failure — fail closed.
  }
}

const MAX_REDIRECTS = 3;

/**
 * Fetches a URL that may come from attacker-writable data (scraped listings,
 * user-editable business profiles), validating the URL — and every redirect
 * hop — against `isSafeFetchTarget` before it's followed. Returns `null` if
 * the initial URL or any hop fails validation, or after `MAX_REDIRECTS` hops
 * without landing on a final response.
 */
export async function fetchSafely(url: string): Promise<Response | null> {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    if (!(await isSafeFetchTarget(currentUrl))) return null;

    const response = await fetch(currentUrl, { redirect: 'manual' });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) return response;

    const location = response.headers.get('location');
    if (!location) return null;

    currentUrl = new URL(location, currentUrl).toString();
  }

  return null; // Too many redirects.
}
