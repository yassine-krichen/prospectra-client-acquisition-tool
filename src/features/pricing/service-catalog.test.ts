import { describe, expect, it } from 'vitest';

import {
  getCatalogEntry,
  getInfraHostingRetainerRange,
  serviceTypeSchema,
  type CatalogEntry,
} from './service-catalog';

const TIERED_SERVICES = ['landing_page', 'full_stack_app', 'linkedin_media_management'] as const;
const TIERS_LOW_TO_HIGH = ['1-10', '11-50', '51-200'] as const;

function asPriceRange(entry: CatalogEntry): { minCents: number; maxCents: number } {
  if (entry === 'manual_quote') throw new Error('expected a numeric price range, got manual_quote');
  return entry;
}

describe('service-catalog', () => {
  it('has a catalog entry for every ServiceType enum member', () => {
    for (const service of serviceTypeSchema.options) {
      if (service === 'infra_hosting_retainer') {
        expect(getInfraHostingRetainerRange()).toBeDefined();
        continue;
      }
      expect(getCatalogEntry(service, '1-10')).toBeDefined();
    }
  });

  it.each(TIERED_SERVICES)('has non-decreasing min/max cents across tiers for %s', (service) => {
    const ranges = TIERS_LOW_TO_HIGH.map((tier) => asPriceRange(getCatalogEntry(service, tier)));

    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].minCents).toBeGreaterThanOrEqual(ranges[i - 1].minCents);
      expect(ranges[i].maxCents).toBeGreaterThanOrEqual(ranges[i - 1].maxCents);
    }
  });

  it.each(TIERED_SERVICES)('is exactly the string "manual_quote" for the 201+ tier of %s, never a number', (service) => {
    const entry = getCatalogEntry(service, '201+');

    expect(entry).toBe('manual_quote');
    expect(typeof entry).toBe('string');
  });

  it.each(TIERED_SERVICES)('treats an unknown company size as manual_quote for %s', (service) => {
    expect(getCatalogEntry(service, 'unknown')).toBe('manual_quote');
  });

  it('exposes a flat, non-tiered price range for infra_hosting_retainer', () => {
    const range = getInfraHostingRetainerRange();

    expect(range.minCents).toBeLessThan(range.maxCents);
  });
});
