// Domain normalization shared by every discovery source and the orchestrator's
// dedupe step, so "example.com" and "www.Example.com" are always treated as
// the same prospect.

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * Extracts a normalized domain from a website URL, or `null` if the URL is
 * missing/unparseable. Never throws.
 */
export function extractDomain(url: string | null): string | null {
  if (!url) return null;

  try {
    const { hostname } = new URL(url);
    return normalizeDomain(hostname);
  } catch {
    return null;
  }
}
