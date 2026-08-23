import { describe, expect, it } from 'vitest';

import { NY_TARGET_CATEGORIES, pickDailyCategory } from './ny-target-categories';

describe('pickDailyCategory', () => {
  it('returns the same category for any two timestamps on the same UTC day', () => {
    const morning = new Date('2026-08-21T00:00:00.000Z');
    const night = new Date('2026-08-21T23:59:59.999Z');

    expect(pickDailyCategory(morning)).toBe(pickDailyCategory(night));
  });

  it('returns a different category on the next UTC day (unless the list wraps)', () => {
    const day = new Date('2026-08-21T12:00:00.000Z');
    const nextDay = new Date('2026-08-22T12:00:00.000Z');

    expect(pickDailyCategory(day)).not.toBe(pickDailyCategory(nextDay));
  });

  it('always returns a category from the fixed list', () => {
    const date = new Date('2026-09-05T00:00:00.000Z');
    expect(NY_TARGET_CATEGORIES).toContain(pickDailyCategory(date));
  });

  it('repeats the rotation exactly every NY_TARGET_CATEGORIES.length days', () => {
    const base = new Date('2026-08-21T00:00:00.000Z');
    const oneCycleLater = new Date(base.getTime() + NY_TARGET_CATEGORIES.length * 24 * 60 * 60 * 1000);

    expect(pickDailyCategory(oneCycleLater)).toBe(pickDailyCategory(base));
  });
});
