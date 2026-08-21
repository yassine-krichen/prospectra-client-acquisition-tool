import { resolveMx } from 'node:dns/promises';

// Verifies a guessed email's domain is *plausible* to receive mail - an MX
// record exists - without ever attempting a real SMTP RCPT-TO handshake.
// Raw SMTP over port 25 is commonly blocked on serverless/PaaS hosting
// (this project targets Vercel serverless), so this deliberately stops at
// MX-existence + basic domain format validity. That's meaningfully weaker
// evidence than Hunter/PDL's verified results, which is why
// enrichment.service.ts scores a pattern-guess+MX-only email at a much
// lower `emailConfidence` than either paid source.

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Checks that `domain` is syntactically a domain and has at least one MX
 * record. Returns `false` (rather than throwing) for a malformed domain, a
 * domain with no MX records, or a DNS resolution failure - all of which mean
 * "don't trust a guessed email at this domain".
 */
export async function domainAcceptsEmail(domain: string): Promise<boolean> {
  const normalized = domain.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) return false;

  try {
    const records = await resolveMx(normalized);
    return records.length > 0;
  } catch {
    return false;
  }
}
