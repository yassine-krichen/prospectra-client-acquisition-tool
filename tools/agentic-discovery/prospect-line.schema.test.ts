import { describe, expect, it } from 'vitest';

import { agenticProspectLineSchema } from './prospect-line.schema';

function validLine() {
  return {
    companyName: 'Acme Dental',
    domain: 'acmedental.com',
    websiteUrl: 'https://acmedental.com',
    industry: 'local_service',
    companySize: '1-10',
    city: 'Brooklyn',
    country: 'US',
    phone: '+1 555-000-1111',
    address: '123 Main St',
    signalType: 'no_https',
    signalStrength: 'strong',
    signalDescription: 'Site serves over plain HTTP',
    evidenceUrl: 'https://acmedental.com',
    evidenceSummary: 'curl shows no TLS certificate',
    secondarySignal: null,
  };
}

describe('agenticProspectLineSchema', () => {
  it('parses a fully populated valid line', () => {
    const result = agenticProspectLineSchema.safeParse(validLine());

    expect(result.success).toBe(true);
  });

  it('parses a valid line where every nullable field is explicitly null', () => {
    const line = {
      ...validLine(),
      domain: null,
      websiteUrl: null,
      city: null,
      country: null,
      phone: null,
      address: null,
      secondarySignal: null,
    };

    const result = agenticProspectLineSchema.safeParse(line);

    expect(result.success).toBe(true);
  });

  it('rejects a line missing companyName', () => {
    const { companyName, ...rest } = validLine();

    expect(agenticProspectLineSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty-string companyName', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), companyName: '' });

    expect(result.success).toBe(false);
  });

  it('rejects a non-string companyName', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), companyName: 42 });

    expect(result.success).toBe(false);
  });

  it('rejects a websiteUrl that is not a valid URL', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), websiteUrl: 'not-a-url' });

    expect(result.success).toBe(false);
  });

  it('rejects an evidenceUrl that is not a valid URL', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), evidenceUrl: 'not-a-url' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty-string evidenceSummary', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), evidenceSummary: '' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty-string signalDescription', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), signalDescription: '' });

    expect(result.success).toBe(false);
  });

  it('rejects an industry value outside the allowed enum', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), industry: 'fintech' });

    expect(result.success).toBe(false);
  });

  it('rejects a companySize value outside the allowed enum', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), companySize: '1000+' });

    expect(result.success).toBe(false);
  });

  it('rejects a signalType value outside the allowed enum', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), signalType: 'made_up_signal' });

    expect(result.success).toBe(false);
  });

  it('rejects a signalStrength value outside the allowed enum', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), signalStrength: 'extreme' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty-string domain (nullable does not mean any string is allowed)', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), domain: '' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty-string phone', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), phone: '' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty-string address', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), address: '' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty-string city', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), city: '' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty-string country', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), country: '' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty-string secondarySignal', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), secondarySignal: '' });

    expect(result.success).toBe(false);
  });

  it('accepts a non-null secondarySignal', () => {
    const result = agenticProspectLineSchema.safeParse({ ...validLine(), secondarySignal: 'Also hiring devs' });

    expect(result.success).toBe(true);
  });

  it('rejects non-http(s) evidenceUrl and contactPageUrl schemes', () => {
    expect(agenticProspectLineSchema.safeParse({ ...validLine(), evidenceUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(agenticProspectLineSchema.safeParse({ ...validLine(), evidenceUrl: 'file:///etc/passwd' }).success).toBe(false);
    expect(agenticProspectLineSchema.safeParse({ ...validLine(), contactPageUrl: 'data:text/html,x' }).success).toBe(false);
  });
});
