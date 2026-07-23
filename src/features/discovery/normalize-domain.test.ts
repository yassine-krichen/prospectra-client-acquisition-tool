import { describe, expect, it } from 'vitest';

import { extractDomain, normalizeDomain } from './normalize-domain';

describe('normalizeDomain', () => {
  it('lowercases an all-uppercase domain', () => {
    expect(normalizeDomain('EXAMPLE.COM')).toBe('example.com');
  });

  it('strips a leading www. from a mixed-case domain', () => {
    expect(normalizeDomain('www.Example.com')).toBe('example.com');
  });

  it('leaves an already-normalized domain unchanged', () => {
    expect(normalizeDomain('example.com')).toBe('example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDomain('  example.com  ')).toBe('example.com');
  });

  it('treats www.Example.com, EXAMPLE.COM, and example.com as identical', () => {
    const normalized = new Set(['www.Example.com', 'EXAMPLE.COM', 'example.com'].map(normalizeDomain));

    expect(normalized.size).toBe(1);
    expect([...normalized]).toEqual(['example.com']);
  });

  it('only strips a leading "www." and leaves a "www" subdomain-lookalike untouched', () => {
    expect(normalizeDomain('wwww.example.com')).toBe('wwww.example.com');
  });

  it('strips www. from a subdomain positioned after the host, case-insensitively', () => {
    expect(normalizeDomain('WWW.EXAMPLE.COM')).toBe('example.com');
  });

  it('does not strip www. when it is not a leading prefix', () => {
    expect(normalizeDomain('shop.www.example.com')).toBe('shop.www.example.com');
  });
});

describe('extractDomain', () => {
  it('returns null for a null url', () => {
    expect(extractDomain(null)).toBeNull();
  });

  it('returns null for an empty string url', () => {
    expect(extractDomain('')).toBeNull();
  });

  it('returns null for an unparseable url', () => {
    expect(extractDomain('not a url')).toBeNull();
  });

  it('extracts and normalizes the hostname from a www-prefixed, mixed-case https url', () => {
    expect(extractDomain('https://www.Example.com/path?query=1')).toBe('example.com');
  });

  it('extracts and normalizes the hostname from an uppercase http url', () => {
    expect(extractDomain('http://EXAMPLE.COM')).toBe('example.com');
  });

  it('strips a non-default port from the extracted domain', () => {
    expect(extractDomain('https://example.com:8080/')).toBe('example.com');
  });

  it('extracts the same domain regardless of a trailing slash', () => {
    expect(extractDomain('https://example.com')).toBe(extractDomain('https://example.com/'));
  });

  it('never throws for garbage input', () => {
    expect(() => extractDomain('http://')).not.toThrow();
    expect(() => extractDomain('::::')).not.toThrow();
  });
});
