import { describe, expect, it } from 'vitest';

import { normalizeAddress, normalizeCompanyName, normalizePhone } from './normalize-contact-info';

describe('normalizePhone', () => {
  it('returns null for null input', () => {
    expect(normalizePhone(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(normalizePhone('')).toBeNull();
  });

  it('strips formatting characters down to digits only', () => {
    expect(normalizePhone('(512) 766-0970')).toBe('5127660970');
  });

  it('drops a leading US country code "1" from an 11-digit number', () => {
    expect(normalizePhone('+1 (512) 766-0970')).toBe('5127660970');
  });

  it('keeps an 11-digit number as-is when it does not start with "1"', () => {
    expect(normalizePhone('25127660970')).toBe('25127660970');
  });

  it('treats two differently-formatted phone numbers as equal once normalized', () => {
    expect(normalizePhone('512-766-0970')).toBe(normalizePhone('(512) 766-0970'));
  });
});

describe('normalizeAddress', () => {
  it('returns null for null input', () => {
    expect(normalizeAddress(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(normalizeAddress('')).toBeNull();
  });

  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeAddress('  123  Main   Street  ')).toBe('123 main street');
  });

  it('expands common street-suffix abbreviations', () => {
    expect(normalizeAddress('1408 W Ben White Blvd')).toBe('1408 w ben white boulevard');
  });

  it('treats an abbreviated and spelled-out street suffix as equal once normalized', () => {
    expect(normalizeAddress('123 Main St')).toBe(normalizeAddress('123 Main Street'));
    expect(normalizeAddress('456 Oak Ave')).toBe(normalizeAddress('456 Oak Avenue'));
    expect(normalizeAddress('789 Elm Rd')).toBe(normalizeAddress('789 Elm Road'));
    expect(normalizeAddress('12 Pine Dr')).toBe(normalizeAddress('12 Pine Drive'));
    expect(normalizeAddress('34 Birch Ln')).toBe(normalizeAddress('34 Birch Lane'));
  });
});

describe('normalizeCompanyName', () => {
  it('lowercases and trims', () => {
    expect(normalizeCompanyName('  Joe Roofing  ')).toBe('joe roofing');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeCompanyName('Joe   Roofing   Co')).toBe('joe roofing');
  });

  it('strips punctuation', () => {
    expect(normalizeCompanyName('Joe, Roofing.')).toBe('joe roofing');
  });

  it('strips a single trailing legal-suffix token', () => {
    expect(normalizeCompanyName('Acme LLC')).toBe('acme');
    expect(normalizeCompanyName('Acme Inc')).toBe('acme');
    expect(normalizeCompanyName('Acme Incorporated')).toBe('acme');
    expect(normalizeCompanyName('Acme Ltd')).toBe('acme');
    expect(normalizeCompanyName('Acme Limited')).toBe('acme');
    expect(normalizeCompanyName('Acme Corp')).toBe('acme');
    expect(normalizeCompanyName('Acme Corporation')).toBe('acme');
    expect(normalizeCompanyName('Acme Co')).toBe('acme');
    expect(normalizeCompanyName('Acme Company')).toBe('acme');
    expect(normalizeCompanyName('Acme Plc')).toBe('acme');
    expect(normalizeCompanyName('Acme LLP')).toBe('acme');
  });

  it('does not strip a legal-suffix word that is not the last word', () => {
    expect(normalizeCompanyName('Corp Consulting')).toBe('corp consulting');
  });

  it('treats "Joe\'s Roofing LLC" and "Joe\'s Roofing" as equal once normalized', () => {
    expect(normalizeCompanyName("Joe's Roofing LLC")).toBe(normalizeCompanyName("Joe's Roofing"));
  });

  it('does NOT treat "Joe Roofing" and "Joe\'s Roofing" as equal (documented false negative - missing possessive)', () => {
    expect(normalizeCompanyName('Joe Roofing')).not.toBe(normalizeCompanyName("Joe's Roofing"));
  });
});
