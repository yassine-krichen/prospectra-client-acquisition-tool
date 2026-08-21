// Login audit trail helpers (see User model in schema.prisma). No new
// dependency for user-agent parsing - a handful of regexes cover the
// browsers/devices this dashboard will ever realistically see, and the raw
// user-agent string is stored alongside the parsed guess anyway, so nothing
// is lost if a given UA doesn't match any of them.

/**
 * Best-effort client IP from the headers Vercel's proxy sets
 * (`x-forwarded-for` - first entry is the original client; falls back to
 * `x-real-ip`). `NextRequest.ip` was removed in Next 15, hence reading
 * headers directly rather than a framework-provided property.
 */
export function getClientIp(request: Request): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const [first] = forwardedFor.split(',');
    return first?.trim() || null;
  }
  return request.headers.get('x-real-ip');
}

export interface ParsedUserAgent {
  browser: string;
  device: string;
}

const BROWSER_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/CriOS\//, 'Chrome (iOS)'],
  [/FxiOS\//, 'Firefox (iOS)'],
  [/Chrome\//, 'Chrome'],
  [/Firefox\//, 'Firefox'],
  [/Version\/.*Safari\//, 'Safari'],
];

const DEVICE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Macintosh/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

function matchFirst(userAgent: string, patterns: ReadonlyArray<[RegExp, string]>): string {
  return patterns.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Unknown';
}

export function parseUserAgent(userAgent: string | null): ParsedUserAgent {
  if (!userAgent) return { browser: 'Unknown', device: 'Unknown' };

  return {
    browser: matchFirst(userAgent, BROWSER_PATTERNS),
    device: matchFirst(userAgent, DEVICE_PATTERNS),
  };
}
