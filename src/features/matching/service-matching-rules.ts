import { getCatalogEntry, getInfraHostingRetainerRange } from '@/features/pricing/service-catalog';
import type { ServiceType } from '@/features/pricing/service-catalog';
import type { CompanySize, EstimatedBudget, Industry, ProjectFit, Signal } from '@/features/prospects/prospect.types';

// Pure rules engine mapping a single discovered `Signal` (+ companySize/
// industry context) to a set of service suggestions. No I/O — every
// suggestion's pricing comes from `service-catalog.ts`'s fixed lookup, never
// duplicated here. `source: 'rules'` is a literal today, widening later if
// an LLM-suggestion overlay is layered on top (see `suggestedServices`'s
// schema comment in prisma/schema.prisma).

export interface PriceRangeCents {
  min: number;
  max: number;
}

export interface ServiceSuggestion {
  service: ServiceType;
  role: 'primary' | 'cross_sell';
  priceRangeCents: PriceRangeCents | null;
  requiresManualQuote: boolean;
  reasoning: string;
  source: 'rules';
}

export interface ComputeServiceSuggestionsInput {
  signal: Signal;
  companySize: CompanySize;
  industry: Industry;
}

// companySize tiers large enough (or an industry product-oriented enough)
// to warrant a full rebuild rather than just a landing-page refresh when a
// stale-site signal fires.
const LARGE_COMPANY_SIZES: ReadonlySet<CompanySize> = new Set(['11-50', '51-200', '201+']);
const FULL_REBUILD_INDUSTRIES: ReadonlySet<Industry> = new Set(['saas', 'ecommerce', 'agency']);

type TieredService = Extract<ServiceType, 'landing_page' | 'full_stack_app' | 'linkedin_media_management'>;

function tieredSuggestion(
  service: TieredService,
  companySize: CompanySize,
  role: 'primary' | 'cross_sell',
  reasoning: string
): ServiceSuggestion {
  const entry = getCatalogEntry(service, companySize);

  if (entry === 'manual_quote') {
    return {
      service,
      role,
      priceRangeCents: null,
      requiresManualQuote: true,
      reasoning: `${reasoning} Company is large enough (or of unknown size) that this needs a manual quote, not a catalog number.`,
      source: 'rules',
    };
  }

  return {
    service,
    role,
    priceRangeCents: { min: entry.minCents, max: entry.maxCents },
    requiresManualQuote: false,
    reasoning,
    source: 'rules',
  };
}

function infraHostingCrossSell(): ServiceSuggestion {
  const range = getInfraHostingRetainerRange();
  return {
    service: 'infra_hosting_retainer',
    role: 'cross_sell',
    priceRangeCents: { min: range.minCents, max: range.maxCents },
    requiresManualQuote: false,
    reasoning: 'Every engagement is a candidate for an ongoing hosting/infra retainer, regardless of the triggering signal.',
    source: 'rules',
  };
}

function linkedinMediaManagementCrossSell(companySize: CompanySize): ServiceSuggestion {
  return tieredSuggestion(
    'linkedin_media_management',
    companySize,
    'cross_sell',
    'Actively hiring — a good fit for ongoing LinkedIn/media management to support recruiting and employer brand.'
  );
}

/**
 * Computes service suggestions for a single discovered signal. Rules are
 * dispatched on `signal.type` (the sole signal object a Prospect carries —
 * see the "known gap" note on `hiring_post` below), then cross-sells are
 * appended independently of whatever primary logic produced.
 */
export function computeServiceSuggestions(input: ComputeServiceSuggestionsInput): ServiceSuggestion[] {
  const { signal, companySize, industry } = input;
  const suggestions: ServiceSuggestion[] = [];

  switch (signal.type) {
    case 'no_website':
    case 'no_https':
      suggestions.push(
        tieredSuggestion(
          'landing_page',
          companySize,
          'primary',
          `No usable live site (${signal.type} signal) — a landing page establishes an initial web presence.`
        )
      );
      break;

    case 'outdated_site':
    case 'old_stack':
    case 'technical_debt': {
      const warrantsFullRebuild = LARGE_COMPANY_SIZES.has(companySize) || FULL_REBUILD_INDUSTRIES.has(industry);
      suggestions.push(
        warrantsFullRebuild
          ? tieredSuggestion(
              'full_stack_app',
              companySize,
              'primary',
              `${signal.type} signal on a larger and/or product-oriented company — warrants a full rebuild rather than a refresh.`
            )
          : tieredSuggestion(
              'landing_page',
              companySize,
              'primary',
              `${signal.type} signal — a landing page refresh fits this company's size/industry better than a full rebuild.`
            )
      );
      break;
    }

    case 'new_launch':
    case 'funding_event':
      suggestions.push(
        tieredSuggestion(
          'full_stack_app',
          companySize,
          'primary',
          `${signal.type} signal (budget signal) — recently launched/funded companies typically need a full build.`
        )
      );
      break;

    case 'hiring_post':
      // KNOWN GAP, resolved: Prospect.signal is a single object, not an
      // array, so there's no co-occurring signal to derive a primary from
      // when hiring_post is the only signal on file. Don't fabricate one —
      // this leaves `suggestions` with zero `primary` entries, which
      // `deriveProjectFitAndBudget` resolves to `projectFit: 'unclear'`.
      break;

    default:
      break;
  }

  // Cross-sells are always applied independently of the primary logic above.
  suggestions.push(infraHostingCrossSell());
  if (signal.type === 'hiring_post') {
    suggestions.push(linkedinMediaManagementCrossSell(companySize));
  }

  return suggestions;
}

type BudgetBucket = Exclude<EstimatedBudget, 'unknown'>;
const BUDGET_BUCKET_ORDER: BudgetBucket[] = ['low', 'mid', 'high'];

function bumpBucket(bucket: BudgetBucket): BudgetBucket {
  const index = BUDGET_BUCKET_ORDER.indexOf(bucket);
  return BUDGET_BUCKET_ORDER[Math.min(index + 1, BUDGET_BUCKET_ORDER.length - 1)];
}

// Two separate threshold tables: comparing a $500/mo retainer against a
// one-off dollar threshold would misclassify every recurring service as
// 'low'. Thresholds are compared against the suggestion's price-range
// midpoint and chosen to track the actual catalog ranges in
// service-catalog.ts (see that file) rather than being arbitrary.
const ONE_OFF_SERVICES: ReadonlySet<ServiceType> = new Set(['landing_page', 'full_stack_app']);
const ONE_OFF_THRESHOLDS = { low: 150_000, mid: 800_000 };
const MONTHLY_THRESHOLDS = { low: 90_000, mid: 150_000 };

function bucketFromPriceRange(service: ServiceType, priceRangeCents: PriceRangeCents): BudgetBucket {
  const thresholds = ONE_OFF_SERVICES.has(service) ? ONE_OFF_THRESHOLDS : MONTHLY_THRESHOLDS;
  const midpoint = (priceRangeCents.min + priceRangeCents.max) / 2;

  if (midpoint < thresholds.low) return 'low';
  if (midpoint < thresholds.mid) return 'mid';
  return 'high';
}

function mapPrimaryServiceToProjectFit(service: ServiceType): ProjectFit {
  if (service === 'landing_page') return 'landing_page';
  if (service === 'full_stack_app') return 'full_stack_app';
  // 'backend_api' has no rule producing it yet — reachable only by future
  // rules. Any other service (the cross-sell-only ones) can never be a
  // primary today, but is mapped to 'unclear' defensively rather than
  // throwing.
  return 'unclear';
}

export interface MatchingDerivation {
  projectFit: ProjectFit;
  estimatedBudget: EstimatedBudget;
}

/**
 * Derives `projectFit`/`estimatedBudget` from a computed suggestion set.
 * `projectFit` maps the primary suggestion's service onto the existing
 * enum (no primary -> 'unclear'). `estimatedBudget` is read off the
 * primary's price range via the one-off/monthly threshold tables above,
 * bumped up one bucket (capped at 'high') when the triggering signal was
 * `new_launch`/`funding_event`, then overridden to 'high' if the primary
 * requires a manual quote — never a fabricated number for that case.
 */
export function deriveProjectFitAndBudget(suggestions: ServiceSuggestion[], signal: Signal): MatchingDerivation {
  const primary = suggestions.find((suggestion) => suggestion.role === 'primary') ?? null;

  if (!primary) {
    return { projectFit: 'unclear', estimatedBudget: 'unknown' };
  }

  const projectFit = mapPrimaryServiceToProjectFit(primary.service);

  let bucket: BudgetBucket = primary.priceRangeCents
    ? bucketFromPriceRange(primary.service, primary.priceRangeCents)
    : 'high';

  if (signal.type === 'new_launch' || signal.type === 'funding_event') {
    bucket = bumpBucket(bucket);
  }

  const estimatedBudget: EstimatedBudget = primary.requiresManualQuote ? 'high' : bucket;

  return { projectFit, estimatedBudget };
}
