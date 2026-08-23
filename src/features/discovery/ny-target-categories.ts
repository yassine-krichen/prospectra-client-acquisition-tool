// Fixed rotation list for the automated daily discovery cron (see the GET
// handler in `app/api/cron/discover/route.ts`). Scoped to established,
// professional New York local services likely to actually have budget for
// web/dev work - low-margin, low-budget categories (nail salons,
// laundromats, convenience stores, etc.) are deliberately excluded per a
// standing business call: don't spend enrichment quota chasing leads
// unlikely to ever convert into paid work.
//
// `pickDailyCategory` is stateless on purpose - no persisted "which
// category ran last" pointer, since a serverless cron invocation has
// nowhere natural to keep that between runs. Deriving the index from the
// UTC calendar date means the rotation is fully deterministic and repeats
// every `NY_TARGET_CATEGORIES.length` days.

export const NY_TARGET_GEOGRAPHY = 'New York, NY';

export const NY_TARGET_CATEGORIES: readonly string[] = [
  'law firm',
  'dental practice',
  'orthodontist',
  'accounting firm',
  'real estate agency',
  'medical practice',
  'architecture firm',
  'marketing agency',
  'financial advisor',
  'wealth management firm',
  'veterinary clinic',
  'interior design studio',
  'management consulting firm',
  'insurance agency',
  'physical therapy clinic',
  'plastic surgery clinic',
  'executive coaching firm',
  'commercial photography studio',
  'venture capital firm',
  'private equity firm',
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function pickDailyCategory(date: Date): string {
  const daysSinceEpoch = Math.floor(date.getTime() / MS_PER_DAY);
  const index = daysSinceEpoch % NY_TARGET_CATEGORIES.length;
  return NY_TARGET_CATEGORIES[index];
}
