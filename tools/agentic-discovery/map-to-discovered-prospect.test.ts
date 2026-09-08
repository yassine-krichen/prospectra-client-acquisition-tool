import { describe, expect, it } from 'vitest';

import { mapToDiscoveredProspect } from './map-to-discovered-prospect';
import type { AgenticProspectLine } from './prospect-line.schema';

function validLine(overrides: Partial<AgenticProspectLine> = {}): AgenticProspectLine {
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
    ...overrides,
  };
}

describe('mapToDiscoveredProspect', () => {
  it('maps every field of a fully populated line to the DiscoveredProspect shape', () => {
    const line = validLine();

    const prospect = mapToDiscoveredProspect(line);

    expect(prospect.companyName).toBe('Acme Dental');
    expect(prospect.domain).toBe('acmedental.com');
    expect(prospect.websiteUrl).toBe('https://acmedental.com');
    expect(prospect.industry).toBe('local_service');
    expect(prospect.companySize).toBe('1-10');
    expect(prospect.location).toEqual({ city: 'Brooklyn', country: 'US', lat: null, lng: null });
    expect(prospect.source).toBe('ai_agent');
    expect(prospect.sourceUrl).toBe('https://acmedental.com');
    expect(prospect.phone).toBe('+1 555-000-1111');
    expect(prospect.address).toBe('123 Main St');
    expect(prospect.corroboratingSourceCount).toBe(1);
    expect(prospect.signal).toEqual({
      type: 'no_https',
      description: 'Site serves over plain HTTP',
      evidence: 'curl shows no TLS certificate',
      strength: 'strong',
    });
    expect(prospect.discoveredAt).toBeInstanceOf(Date);
  });

  it('appends the secondary signal to the evidence string when present', () => {
    const line = validLine({ secondarySignal: 'Also hiring frontend devs' });

    const prospect = mapToDiscoveredProspect(line);

    expect(prospect.signal.evidence).toBe(
      'curl shows no TLS certificate | Secondary: Also hiring frontend devs',
    );
  });

  it('leaves evidence as just the summary when secondarySignal is null', () => {
    const line = validLine({ secondarySignal: null });

    const prospect = mapToDiscoveredProspect(line);

    expect(prospect.signal.evidence).toBe('curl shows no TLS certificate');
  });

  it('normalizes an explicit domain (lowercases, strips leading www.) rather than using it verbatim', () => {
    const line = validLine({ domain: 'WWW.Acme-Dental.COM' });

    const prospect = mapToDiscoveredProspect(line);

    expect(prospect.domain).toBe('acme-dental.com');
  });

  it('derives the domain from websiteUrl when domain is null', () => {
    const line = validLine({ domain: null, websiteUrl: 'https://www.other-domain.example/contact' });

    const prospect = mapToDiscoveredProspect(line);

    expect(prospect.domain).toBe('other-domain.example');
  });

  it('leaves domain null when both domain and websiteUrl are null', () => {
    const line = validLine({ domain: null, websiteUrl: null });

    const prospect = mapToDiscoveredProspect(line);

    expect(prospect.domain).toBeNull();
  });

  it('prefers the explicit domain over deriving one from websiteUrl when both are present', () => {
    const line = validLine({ domain: 'explicit-domain.com', websiteUrl: 'https://different-domain.com' });

    const prospect = mapToDiscoveredProspect(line);

    expect(prospect.domain).toBe('explicit-domain.com');
  });

  it('sets corroboratingSourceCount to 1 for a freshly-mapped prospect', () => {
    const prospect = mapToDiscoveredProspect(validLine());

    expect(prospect.corroboratingSourceCount).toBe(1);
  });

  it('sets source to "ai_agent" for every prospect mapped by this tool', () => {
    const prospect = mapToDiscoveredProspect(validLine());

    expect(prospect.source).toBe('ai_agent');
  });

  it('carries city and country through to location while leaving lat/lng null', () => {
    const line = validLine({ city: null, country: null });

    const prospect = mapToDiscoveredProspect(line);

    expect(prospect.location).toEqual({ city: null, country: null, lat: null, lng: null });
  });
});
