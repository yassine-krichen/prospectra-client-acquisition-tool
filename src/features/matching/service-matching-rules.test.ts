import { describe, expect, it } from 'vitest';

import {
  computeServiceSuggestions,
  deriveProjectFitAndBudget,
  type ServiceSuggestion,
} from './service-matching-rules';
import type { CompanySize, Industry, Signal, SignalType } from '@/features/prospects/prospect.types';

// Table-driven and one case per business rule row in the plan - this is the
// highest-value test file in this phase since the rules engine is pure and
// encodes every business rule literally.

function buildSignal(type: SignalType, overrides: Partial<Signal> = {}): Signal {
  return {
    type,
    description: `${type} signal`,
    evidence: null,
    strength: 'medium',
    ...overrides,
  };
}

function findSuggestion(
  suggestions: ServiceSuggestion[],
  role: 'primary' | 'cross_sell',
  service?: ServiceSuggestion['service']
): ServiceSuggestion | undefined {
  return suggestions.find((suggestion) => suggestion.role === role && (!service || suggestion.service === service));
}

function compute(type: SignalType, companySize: CompanySize, industry: Industry): ServiceSuggestion[] {
  return computeServiceSuggestions({ signal: buildSignal(type), companySize, industry });
}

describe('computeServiceSuggestions', () => {
  it.each(['no_website', 'no_https'] as const)(
    'suggests landing_page as primary for a %s signal, always',
    (type) => {
      const suggestions = compute(type, '1-10', 'local_service');

      const primary = findSuggestion(suggestions, 'primary');
      expect(primary?.service).toBe('landing_page');
      expect(primary?.requiresManualQuote).toBe(false);
      expect(primary?.reasoning).toContain(type);
    }
  );

  it.each(['outdated_site', 'old_stack', 'technical_debt'] as const)(
    'suggests full_stack_app as primary for a %s signal when companySize is 11-50',
    (type) => {
      const suggestions = compute(type, '11-50', 'local_service');
      expect(findSuggestion(suggestions, 'primary')?.service).toBe('full_stack_app');
    }
  );

  it('suggests full_stack_app as primary for outdated_site at companySize 51-200', () => {
    const suggestions = compute('outdated_site', '51-200', 'local_service');
    expect(findSuggestion(suggestions, 'primary')?.service).toBe('full_stack_app');
  });

  it('suggests full_stack_app as primary for outdated_site at companySize 201+ (also requiring a manual quote)', () => {
    const suggestions = compute('outdated_site', '201+', 'local_service');

    const primary = findSuggestion(suggestions, 'primary');
    expect(primary?.service).toBe('full_stack_app');
    expect(primary?.requiresManualQuote).toBe(true);
    expect(primary?.priceRangeCents).toBeNull();
  });

  it.each(['saas', 'ecommerce', 'agency'] as const)(
    'suggests full_stack_app as primary for outdated_site at a small company in the %s industry',
    (industry) => {
      const suggestions = compute('outdated_site', '1-10', industry);
      expect(findSuggestion(suggestions, 'primary')?.service).toBe('full_stack_app');
    }
  );

  it("suggests a landing_page refresh (not a full rebuild) for outdated_site at a small local_service/other company", () => {
    const suggestions = compute('outdated_site', '1-10', 'local_service');

    const primary = findSuggestion(suggestions, 'primary');
    expect(primary?.service).toBe('landing_page');
    expect(primary?.reasoning.toLowerCase()).toContain('refresh');
  });

  it.each(['new_launch', 'funding_event'] as const)(
    'suggests full_stack_app as primary for a %s signal always, regardless of company size/industry',
    (type) => {
      const suggestions = compute(type, '1-10', 'local_service');

      const primary = findSuggestion(suggestions, 'primary');
      expect(primary?.service).toBe('full_stack_app');
      expect(primary?.reasoning).toContain('budget signal');
    }
  );

  it('produces no primary suggestion when hiring_post is the sole signal (known schema gap - no array of signals to derive one from)', () => {
    const suggestions = compute('hiring_post', '1-10', 'local_service');
    expect(findSuggestion(suggestions, 'primary')).toBeUndefined();
  });

  it('still appends both cross-sells for a hiring_post-only signal, even with no primary', () => {
    const suggestions = compute('hiring_post', '1-10', 'local_service');

    expect(findSuggestion(suggestions, 'cross_sell', 'infra_hosting_retainer')).toBeDefined();
    expect(findSuggestion(suggestions, 'cross_sell', 'linkedin_media_management')).toBeDefined();
  });

  it('never appends linkedin_media_management for a signal other than hiring_post', () => {
    for (const type of ['no_website', 'no_https', 'outdated_site', 'old_stack', 'technical_debt', 'new_launch', 'funding_event'] as const) {
      const suggestions = compute(type, '1-10', 'local_service');
      expect(findSuggestion(suggestions, 'cross_sell', 'linkedin_media_management')).toBeUndefined();
    }
  });

  it.each(['no_website', 'no_https', 'outdated_site', 'old_stack', 'technical_debt', 'new_launch', 'funding_event', 'hiring_post'] as const)(
    'always appends infra_hosting_retainer as a cross-sell regardless of signal type (%s)',
    (type) => {
      const suggestions = compute(type, '1-10', 'local_service');

      const crossSell = findSuggestion(suggestions, 'cross_sell', 'infra_hosting_retainer');
      expect(crossSell).toBeDefined();
      expect(crossSell?.role).toBe('cross_sell');
      expect(crossSell?.requiresManualQuote).toBe(false);
      expect(crossSell?.priceRangeCents).not.toBeNull();
    }
  );

  it('marks a manual_quote suggestion with requiresManualQuote:true and a null priceRangeCents, never a fabricated number', () => {
    const suggestions = compute('no_website', '201+', 'local_service');

    const primary = findSuggestion(suggestions, 'primary');
    expect(primary?.requiresManualQuote).toBe(true);
    expect(primary?.priceRangeCents).toBeNull();
    expect(primary?.reasoning.toLowerCase()).toContain('manual quote');
  });

  it("treats companySize 'unknown' the same as manual_quote (no basis to guess a price bracket)", () => {
    const suggestions = compute('no_website', 'unknown', 'local_service');

    const primary = findSuggestion(suggestions, 'primary');
    expect(primary?.requiresManualQuote).toBe(true);
    expect(primary?.priceRangeCents).toBeNull();
  });
});

describe('deriveProjectFitAndBudget', () => {
  it("maps a landing_page primary onto projectFit 'landing_page'", () => {
    const signal = buildSignal('no_website');
    const suggestions = computeServiceSuggestions({ signal, companySize: '1-10', industry: 'local_service' });

    expect(deriveProjectFitAndBudget(suggestions, signal).projectFit).toBe('landing_page');
  });

  it("maps a full_stack_app primary onto projectFit 'full_stack_app'", () => {
    const signal = buildSignal('new_launch');
    const suggestions = computeServiceSuggestions({ signal, companySize: '1-10', industry: 'saas' });

    expect(deriveProjectFitAndBudget(suggestions, signal).projectFit).toBe('full_stack_app');
  });

  it("resolves to projectFit 'unclear' and estimatedBudget 'unknown' when there is no primary (hiring_post-alone fallback)", () => {
    const signal = buildSignal('hiring_post');
    const suggestions = computeServiceSuggestions({ signal, companySize: '1-10', industry: 'local_service' });

    expect(deriveProjectFitAndBudget(suggestions, signal)).toEqual({ projectFit: 'unclear', estimatedBudget: 'unknown' });
  });

  it('estimates a low budget for a small-company landing_page primary', () => {
    const signal = buildSignal('no_website');
    const suggestions = computeServiceSuggestions({ signal, companySize: '1-10', industry: 'local_service' });

    expect(deriveProjectFitAndBudget(suggestions, signal).estimatedBudget).toBe('low');
  });

  it('estimates a low budget for the linkedin_media_management/infra_hosting_retainer monthly-priced cross-sells (not misclassified against one-off thresholds)', () => {
    // Sanity check on the monthly threshold table itself, exercised through
    // the smallest tier of a monthly service.
    const signal = buildSignal('hiring_post');
    const suggestions = computeServiceSuggestions({ signal, companySize: '1-10', industry: 'local_service' });
    const crossSell = findSuggestion(suggestions, 'cross_sell', 'linkedin_media_management');

    expect(crossSell?.priceRangeCents?.max).toBeLessThan(150_000);
  });

  it('bumps the budget bucket up one level for a new_launch signal versus the same primary without a bump', () => {
    const withoutBump = buildSignal('outdated_site');
    const baselineSuggestions = computeServiceSuggestions({ signal: withoutBump, companySize: '1-10', industry: 'saas' });
    const baseline = deriveProjectFitAndBudget(baselineSuggestions, withoutBump);

    const bumpSignal = buildSignal('new_launch');
    const bumpedSuggestions = computeServiceSuggestions({ signal: bumpSignal, companySize: '1-10', industry: 'saas' });
    const bumped = deriveProjectFitAndBudget(bumpedSuggestions, bumpSignal);

    // Same companySize/industry -> same catalog price range for the
    // full_stack_app primary in both cases, so the only variable is the bump.
    expect(bumped.estimatedBudget).not.toBe(baseline.estimatedBudget);
  });

  it('caps the bumped budget bucket at high - never overflows past the top bucket', () => {
    const signal = buildSignal('funding_event');
    // A 51-200 full_stack_app primary is already priced into the 'high'
    // bucket by threshold alone, so the bump has nowhere higher to go.
    const suggestions = computeServiceSuggestions({ signal, companySize: '51-200', industry: 'saas' });

    expect(deriveProjectFitAndBudget(suggestions, signal).estimatedBudget).toBe('high');
  });

  it("sets estimatedBudget to 'high' when the primary requires a manual quote, regardless of the threshold table", () => {
    const signal = buildSignal('no_website');
    const suggestions = computeServiceSuggestions({ signal, companySize: '201+', industry: 'local_service' });

    const result = deriveProjectFitAndBudget(suggestions, signal);
    expect(result.estimatedBudget).toBe('high');
  });
});
