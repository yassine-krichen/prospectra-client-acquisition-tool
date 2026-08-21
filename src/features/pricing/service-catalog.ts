import { env } from '@/common/config/env';
import type { CompanySize } from '@/features/prospects/prospect.types';
import { serviceTypeSchema, type ServiceType } from '@/features/pricing/service-type';

// `serviceTypeSchema`/`ServiceType` live in ./service-type (not here) so
// prospect.types.ts - imported by client components - doesn't have to pull
// in this file's `env` import. Re-exported so everything that already
// imports them from here keeps working unchanged.
export { serviceTypeSchema, type ServiceType };

export interface PriceRange {
  minCents: number;
  maxCents: number;
}

// `'manual_quote'` is a literal string, never a shape with an optional
// number - that guarantees the 201+ tier can never be silently treated as a
// computable price by the type system.
export type CatalogEntry = PriceRange | 'manual_quote';

const MANUAL_QUOTE = 'manual_quote' as const;

// Fixed const catalog, not a DB table - see service-catalog's design note in
// the implementation plan: the catalog is not user-editable via any UI in
// this scope, and `Job.service`/`ServiceType` already gives stronger
// referential integrity than a DB table would for the same rare-write case.
//
// Per-tier cent figures are the actual agreed pricing (decided directly with
// the product owner), not placeholders.
const TIERED_CATALOG: Record<
  Extract<ServiceType, 'landing_page' | 'full_stack_app' | 'linkedin_media_management'>,
  Record<Exclude<CompanySize, 'unknown'>, CatalogEntry>
> = {
  landing_page: {
    '1-10': { minCents: 80_000, maxCents: 150_000 },
    '11-50': { minCents: 150_000, maxCents: 300_000 },
    '51-200': { minCents: 300_000, maxCents: 600_000 },
    '201+': MANUAL_QUOTE,
  },
  full_stack_app: {
    '1-10': { minCents: 300_000, maxCents: 800_000 },
    '11-50': { minCents: 800_000, maxCents: 2_000_000 },
    '51-200': { minCents: 2_000_000, maxCents: 5_000_000 },
    '201+': MANUAL_QUOTE,
  },
  linkedin_media_management: {
    '1-10': { minCents: 30_000, maxCents: 50_000 },
    '11-50': { minCents: 50_000, maxCents: 90_000 },
    '51-200': { minCents: 90_000, maxCents: 150_000 },
    '201+': MANUAL_QUOTE,
  },
};

// Flat, not tiered by company size - per spec, `infra_hosting_retainer` is a
// single monthly hosting/infra retainer price regardless of client size.
const INFRA_HOSTING_RETAINER_RANGE: PriceRange = { minCents: 5_000, maxCents: 15_000 };

// Each ServiceType has exactly one valid cadence - landing_page/full_stack_app
// are one-off builds, linkedin_media_management/infra_hosting_retainer are
// monthly retainers. Derived here (not a free-form field a caller picks)
// so a Job can never be created with an invalid service+cadence pairing -
// see createJob in create-job.service.ts.
const SERVICE_CADENCE: Record<ServiceType, 'one_off' | 'recurring'> = {
  landing_page: 'one_off',
  full_stack_app: 'one_off',
  linkedin_media_management: 'recurring',
  infra_hosting_retainer: 'recurring',
};

/** The one valid `JobCadence` for a given service - see `SERVICE_CADENCE`'s doc comment. */
export function getServiceCadence(service: ServiceType): 'one_off' | 'recurring' {
  return SERVICE_CADENCE[service];
}

export const FREE_REVISION_ROUNDS = 2;
export const FREE_REVISION_WINDOW_DAYS = 30;
export const RETAINER_LOCKIN_MONTHS = 3;
// Default only - the effective rate is always read from `env.HOURLY_RATE_CENTS`
// at point of use (overridable without a code change), not this constant.
export const HOURLY_RATE_CENTS_DEFAULT = 5_000;

/**
 * Catalog lookup for a tiered service (everything except
 * `infra_hosting_retainer`, which has its own flat accessor below).
 * `companySize: 'unknown'` is treated the same as the `201+` tier -
 * `'manual_quote'` - since there's no basis to guess a price bracket for a
 * company of unknown size.
 */
export function getCatalogEntry(
  service: Extract<ServiceType, 'landing_page' | 'full_stack_app' | 'linkedin_media_management'>,
  companySize: CompanySize
): CatalogEntry {
  if (companySize === 'unknown') return MANUAL_QUOTE;
  return TIERED_CATALOG[service][companySize];
}

/** Flat price range for `infra_hosting_retainer` - not tiered by company size. */
export function getInfraHostingRetainerRange(): PriceRange {
  return INFRA_HOSTING_RETAINER_RANGE;
}

/** Current hourly rate for manual-quote estimation, read fresh from env each call. */
export function getHourlyRateCents(): number {
  return env.HOURLY_RATE_CENTS;
}
