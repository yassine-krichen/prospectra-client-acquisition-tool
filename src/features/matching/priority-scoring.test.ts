import { describe, expect, it } from 'vitest';

import { computePriorityScore } from '@/features/matching/priority-scoring';
import type { DiscoveredProspect } from '@/features/discovery/discovery.types';
import type { Signal } from '@/features/prospects/prospect.types';

function buildSignal(strength: Signal['strength']): Signal {
  return { type: 'outdated_site', description: 'stale', evidence: null, strength };
}

function buildProspect(overrides: Partial<DiscoveredProspect> = {}): DiscoveredProspect {
  return {
    companyName: 'Acme Co',
    domain: null,
    websiteUrl: null,
    industry: 'local_service',
    location: { city: null, country: null, lat: null, lng: null },
    companySize: 'unknown',
    source: 'manual',
    sourceUrl: 'https://example.com/source',
    discoveredAt: new Date('2026-01-01'),
    signal: buildSignal('weak'),
    phone: null,
    address: null,
    corroboratingSourceCount: 1,
    ...overrides,
  };
}

describe('computePriorityScore', () => {
  it('scores the minimum case exactly: weak signal, unknown size, no contact info, single source, non-priority market', () => {
    const prospect = buildProspect();

    expect(computePriorityScore(prospect, { geography: 'Toronto, Canada' })).toBe(10);
  });

  it('scores the maximum-described case exactly: strong signal, largest size, full contact info, 4 corroborating sources, priority market', () => {
    const prospect = buildProspect({
      signal: buildSignal('strong'),
      companySize: '201+',
      domain: 'acme.com',
      phone: '512-555-0100',
      address: '123 Main St',
      corroboratingSourceCount: 4,
    });

    // 30 (strong) + 20 (largest size) + 15 (full contact) + 24 (corroboration, capped) + 10 (priority market) = 99
    expect(computePriorityScore(prospect, { geography: 'Austin, TX' })).toBe(99);
  });

  it.each([
    ['weak', 10],
    ['medium', 20],
    ['strong', 30],
  ] as const)('contributes %s signal strength as %i on its own', (strength, expectedScore) => {
    const prospect = buildProspect({ signal: buildSignal(strength) });

    expect(computePriorityScore(prospect)).toBe(expectedScore);
  });

  it.each([
    ['unknown', 0],
    ['1-10', 5],
    ['11-50', 10],
    ['51-200', 15],
    ['201+', 20],
  ] as const)('contributes companySize %s as +%i on top of the weak-signal base', (companySize, expectedBonus) => {
    const prospect = buildProspect({ companySize });

    expect(computePriorityScore(prospect)).toBe(10 + expectedBonus);
  });

  it('contributes +5 per contactability channel present, capped at +15 for all three', () => {
    const domainOnly = buildProspect({ domain: 'acme.com' });
    const websiteOnly = buildProspect({ websiteUrl: 'https://acme.com' });
    const phoneOnly = buildProspect({ phone: '512-555-0100' });
    const addressOnly = buildProspect({ address: '123 Main St' });
    const allThree = buildProspect({ domain: 'acme.com', phone: '512-555-0100', address: '123 Main St' });

    expect(computePriorityScore(domainOnly)).toBe(15);
    expect(computePriorityScore(websiteOnly)).toBe(15);
    expect(computePriorityScore(phoneOnly)).toBe(15);
    expect(computePriorityScore(addressOnly)).toBe(15);
    expect(computePriorityScore(allThree)).toBe(25);
  });

  it('does not double-count domain and websiteUrl toward contactability', () => {
    const prospect = buildProspect({ domain: 'acme.com', websiteUrl: 'https://acme.com' });

    expect(computePriorityScore(prospect)).toBe(15);
  });

  it('contributes (count - 1) * 8 for corroboration, uncapped below the cap threshold', () => {
    const twoSources = buildProspect({ corroboratingSourceCount: 2 });
    const threeSources = buildProspect({ corroboratingSourceCount: 3 });

    expect(computePriorityScore(twoSources)).toBe(10 + 8);
    expect(computePriorityScore(threeSources)).toBe(10 + 16);
  });

  it('caps the corroboration bonus at +24 regardless of how high corroboratingSourceCount goes', () => {
    const fourSources = buildProspect({ corroboratingSourceCount: 4 });
    const tenSources = buildProspect({ corroboratingSourceCount: 10 });

    expect(computePriorityScore(fourSources)).toBe(10 + 24);
    expect(computePriorityScore(tenSources)).toBe(10 + 24);
  });

  it('contributes a flat +10 when geography is a priority market', () => {
    const prospect = buildProspect();

    expect(computePriorityScore(prospect, { geography: 'Austin, TX' })).toBe(20);
  });

  it('contributes 0 when geography is not a priority market or is omitted', () => {
    const prospect = buildProspect();

    expect(computePriorityScore(prospect, { geography: 'Toronto, Canada' })).toBe(10);
    expect(computePriorityScore(prospect)).toBe(10);
  });
});
