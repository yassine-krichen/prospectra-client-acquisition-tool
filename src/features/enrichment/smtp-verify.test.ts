import { afterEach, describe, expect, it, vi } from 'vitest';

// `dns.resolveMx` is mocked at the module level (same boundary as
// `is-safe-fetch-target.test.ts`/`signal-detection.test.ts` mock `dns.lookup`)
// so this suite never performs a real DNS lookup.
vi.mock('node:dns/promises', () => ({
  resolveMx: vi.fn(),
}));

import { resolveMx } from 'node:dns/promises';

import { domainAcceptsEmail } from './smtp-verify';

const mockResolveMx = vi.mocked(resolveMx);

describe('domainAcceptsEmail', () => {
  afterEach(() => {
    mockResolveMx.mockReset();
  });

  it('returns true for a domain with at least one MX record', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'mail.acme.com', priority: 10 }]);

    expect(await domainAcceptsEmail('acme.com')).toBe(true);
  });

  it('returns false for a domain with no MX records', async () => {
    mockResolveMx.mockResolvedValue([]);

    expect(await domainAcceptsEmail('acme.com')).toBe(false);
  });

  it('fails closed and returns false, not throws, when the DNS lookup errors (e.g. NXDOMAIN)', async () => {
    mockResolveMx.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(domainAcceptsEmail('nonexistent-domain-xyz.invalid')).resolves.toBe(false);
    expect(mockResolveMx).toHaveBeenCalled();
  });

  it('rejects a malformed domain before ever performing a DNS lookup', async () => {
    expect(await domainAcceptsEmail('not a domain')).toBe(false);
    expect(mockResolveMx).not.toHaveBeenCalled();
  });

  it('is case-insensitive and trims whitespace before validating/resolving the domain', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'mail.acme.com', priority: 10 }]);

    expect(await domainAcceptsEmail('  ACME.com  ')).toBe(true);
    expect(mockResolveMx).toHaveBeenCalledWith('acme.com');
  });
});
