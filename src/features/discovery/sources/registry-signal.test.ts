import { describe, expect, it } from 'vitest';

import { isBaselineSignal } from '@/features/discovery/signal-detection';

import { buildRegistrySignal } from './registry-signal';

describe('buildRegistrySignal', () => {
  it('returns a strong recently_registered signal for a registration date under 90 days ago', () => {
    const registrationDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const signal = buildRegistrySignal(registrationDate, 'UK Companies House');

    expect(signal).toEqual({
      type: 'recently_registered',
      description: 'Registered with UK Companies House within the last 90 days',
      evidence: registrationDate,
      strength: 'strong',
    });
  });

  it('returns a medium recently_registered signal for a registration date between 90 and 365 days ago', () => {
    const registrationDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();

    const signal = buildRegistrySignal(registrationDate, 'Texas Comptroller');

    expect(signal).toEqual({
      type: 'recently_registered',
      description: 'Registered with Texas Comptroller within the last year',
      evidence: registrationDate,
      strength: 'medium',
    });
  });

  it('returns the generic weak fallback for a registration date older than 365 days', () => {
    const registrationDate = new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000).toISOString();

    const signal = buildRegistrySignal(registrationDate, 'UK Companies House');

    expect(signal).toEqual({
      type: 'technical_debt',
      description: 'No specific signal detected in the UK Companies House listing; included via category+geography match',
      evidence: registrationDate,
      strength: 'weak',
    });
  });

  it('returns the generic weak fallback when registrationDate is null', () => {
    const signal = buildRegistrySignal(null, 'UK Companies House');

    expect(signal).toEqual({
      type: 'technical_debt',
      description: 'No specific signal detected in the UK Companies House listing; included via category+geography match',
      evidence: null,
      strength: 'weak',
    });
  });

  it('returns the generic weak fallback when registrationDate is unparseable', () => {
    const signal = buildRegistrySignal('not-a-date', 'Texas Comptroller');

    expect(signal).toEqual({
      type: 'technical_debt',
      description: 'No specific signal detected in the Texas Comptroller listing; included via category+geography match',
      evidence: 'not-a-date',
      strength: 'weak',
    });
  });

  it('produces a fallback recognized by isBaselineSignal - the thin-prospect filter must catch registry-source prospects too', () => {
    const signal = buildRegistrySignal(null, 'UK Companies House');

    expect(isBaselineSignal(signal)).toBe(true);
  });
});
