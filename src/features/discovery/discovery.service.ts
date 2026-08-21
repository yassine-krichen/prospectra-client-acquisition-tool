import type { DiscoveryRun, Prisma } from '@/lib/generated/prisma/client';
import { env } from '@/common/config/env';
import { prisma } from '@/common/db/client';
import { discoveryQuerySchema, type DiscoveredProspect, type DiscoveryQuery, type SourceResult } from '@/features/discovery/discovery.types';
import { DISCOVERY_SOURCES } from '@/features/discovery/discovery-source-registry';
import { normalizeAddress, normalizePhone } from '@/features/discovery/normalize-contact-info';
import { normalizeDomain } from '@/features/discovery/normalize-domain';
import { runGooglePlacesSource } from '@/features/discovery/sources/google-places.source';
import { lookupStaleStack } from '@/features/discovery/sources/builtwith.source';
import { detectTechStack } from '@/features/discovery/sources/tech-stack-detector.source';
import { runYellowPagesSource } from '@/features/discovery/sources/yellowpages.source';
import { runOverpassSource } from '@/features/discovery/sources/overpass.source';
import { runProductHuntSource } from '@/features/discovery/sources/product-hunt.source';
import { runCrunchbaseSource } from '@/features/discovery/sources/crunchbase.source';
import { lookupGitHubEvidence } from '@/features/discovery/sources/github.source';
import { runIndieHackersSource } from '@/features/discovery/sources/indiehackers.source';
import { isBaselineSignal } from '@/features/discovery/signal-detection';
import { computeServiceSuggestions, deriveProjectFitAndBudget } from '@/features/matching/service-matching-rules';
import { computePriorityScore } from '@/features/matching/priority-scoring';
import { toPrismaCompanySize } from '@/features/prospects/company-size.mapper';
import type { SignalStrength } from '@/features/prospects/prospect.types';

// Branch A = local/SMB discovery (category+geography search: Google Places,
// yellowpages). Branch B = startup/SaaS discovery (topic/recency-based:
// Product Hunt, Crunchbase, Indie Hackers) - same `DiscoveryQuery` shape is
// reused (`category` doubles as a topic/keyword filter, and `geography` is
// mostly ignored by Branch B sources - see each source's own doc comment),
// so both branches share one orchestrator and one query type rather than
// duplicating the discovery pipeline. GitHub is neither branch - it's
// enrichment-only, same as BuiltWith (see `ENRICHERS`/`enrichWithGitHub`).
export type DiscoveryBranch = 'a' | 'b' | 'both';

// Ordinal comparison only (NOT the priorityScore formula - see
// priority-scoring.ts for that) - used by the enrichers below to decide
// whether a newly-found signal is strictly stronger than what a prospect
// already has, so a later enricher never downgrades an earlier one's finding.
const SIGNAL_STRENGTH_SCORE: Record<SignalStrength, number> = {
  weak: 1,
  medium: 2,
  strong: 3,
};

interface SourceRunSummary {
  source: string;
  ran: boolean;
  reason?: string;
  /**
   * For discovery sources: count of prospects found. For enrichment-only
   * sources (BuiltWith): count of prospects whose signal was upgraded.
   */
  count: number;
}

export interface DiscoveryRunSummary {
  query: DiscoveryQuery;
  branch: DiscoveryBranch;
  sources: SourceRunSummary[];
  totalFound: number;
  inserted: number;
  updated: number;
  /** Existing prospects re-discovered by domain that were left untouched
   * because `doNotContact` is already `true` - see `persistProspect`'s doc
   * comment. */
  skippedDoNotContact: number;
  /** Prospects discarded after the full enrichment chain because they had
   * nothing actionable - no domain/website, no phone, no address, and no
   * signal beyond the baseline "no signal detected" fallback. See
   * `isThinProspect`. */
  discardedThinProspects: number;
}

// Maps each registry source key to the function that actually runs it.
// Built once here rather than duplicating a giant if/else per branch - see
// `runDiscovery`'s loop over `DISCOVERY_SOURCES`.
const SOURCE_RUNNERS: Record<string, (query: DiscoveryQuery) => Promise<SourceResult>> = {
  google_places: runGooglePlacesSource,
  yellowpages: runYellowPagesSource,
  overpass: runOverpassSource,
  product_hunt: runProductHuntSource,
  crunchbase: runCrunchbaseSource,
  indiehackers: runIndieHackersSource,
};

type EnrichResult = { prospect: DiscoveredProspect; enriched: boolean };

/**
 * Enriches a discovered prospect's signal with BuiltWith's tech-stack
 * staleness rules, but only when BuiltWith's signal is at least as strong as
 * whatever the prospect already has - BuiltWith adds evidence, it shouldn't
 * downgrade a stronger signal already detected (by a discovery source, or by
 * an earlier enricher in the chain - see `ENRICHERS`).
 */
async function enrichWithStaleStack(prospect: DiscoveredProspect): Promise<EnrichResult> {
  if (!prospect.domain) return { prospect, enriched: false };

  const staleStack = await lookupStaleStack(prospect.domain);
  if (!staleStack.ok || !staleStack.lookup.signal) return { prospect, enriched: false };

  const existingScore = SIGNAL_STRENGTH_SCORE[prospect.signal.strength];
  const staleStackScore = SIGNAL_STRENGTH_SCORE[staleStack.lookup.signal.strength];
  if (staleStackScore <= existingScore) return { prospect, enriched: false };

  return { prospect: { ...prospect, signal: staleStack.lookup.signal }, enriched: true };
}

/**
 * Enriches a discovered prospect's signal with the first-party, no-API-key
 * tech-stack detector (see tech-stack-detector.source.ts) - same "only
 * upgrade if strictly stronger" comparison as `enrichWithStaleStack`. Runs
 * first in `ENRICHERS` so BuiltWith (paid, rate-limited) naturally acts as a
 * secondary cross-check on top of this rather than the primary source.
 */
async function enrichWithTechStackDetector(prospect: DiscoveredProspect): Promise<EnrichResult> {
  if (!prospect.websiteUrl) return { prospect, enriched: false };

  const detected = await detectTechStack(prospect.websiteUrl);
  if (!detected.ok || !detected.lookup.signal) return { prospect, enriched: false };

  const existingScore = SIGNAL_STRENGTH_SCORE[prospect.signal.strength];
  const detectedScore = SIGNAL_STRENGTH_SCORE[detected.lookup.signal.strength];
  if (detectedScore <= existingScore) return { prospect, enriched: false };

  return { prospect: { ...prospect, signal: detected.lookup.signal }, enriched: true };
}

/**
 * Enriches a discovered prospect's signal with GitHub technical evidence
 * (see github.source.ts's `lookupGitHubEvidence`) - same "only upgrade if
 * strictly stronger" comparison as the other enrichers. Scoped to
 * `industry === 'saas'` prospects only (see `enrichWithGitHubForSaasOnly`):
 * local/SMB businesses essentially never have a GitHub org, and checking
 * them anyway would burn GitHub's tight unauthenticated 60/hour rate limit
 * on lookups that can never match.
 */
async function enrichWithGitHub(prospect: DiscoveredProspect): Promise<EnrichResult> {
  const evidence = await lookupGitHubEvidence(prospect);
  if (!evidence.ok || !evidence.lookup.signal) return { prospect, enriched: false };

  const existingScore = SIGNAL_STRENGTH_SCORE[prospect.signal.strength];
  const evidenceScore = SIGNAL_STRENGTH_SCORE[evidence.lookup.signal.strength];
  if (evidenceScore <= existingScore) return { prospect, enriched: false };

  return { prospect: { ...prospect, signal: evidence.lookup.signal }, enriched: true };
}

/** Gates `enrichWithGitHub` to `industry === 'saas'` prospects - see its doc
 * comment for why. */
async function enrichWithGitHubForSaasOnly(prospect: DiscoveredProspect): Promise<EnrichResult> {
  if (prospect.industry !== 'saas') return { prospect, enriched: false };
  return enrichWithGitHub(prospect);
}

/**
 * True for a prospect with essentially nothing actionable: no domain or
 * website, no phone, no address, and no signal beyond the baseline
 * "no signal detected" fallback (see `isBaselineSignal`). Applied after the
 * full enrichment chain has had a chance to add evidence - primarily
 * relevant to name-only results from Overpass (OSM's structured data is
 * often sparse - a POI can have a name and nothing else), but this is a
 * general filter applied equally to every source's output, not
 * source-specific.
 */
function isThinProspect(prospect: DiscoveredProspect): boolean {
  const hasContactableInfo =
    prospect.domain !== null || prospect.websiteUrl !== null || prospect.phone !== null || prospect.address !== null;
  if (hasContactableInfo) return false;

  return isBaselineSignal(prospect.signal);
}

/**
 * Merges prospects that are the same real-world business, matched in
 * priority order: normalized domain first, then normalized phone, then
 * normalized address - first key that matches an already-seen prospect
 * wins, and that earlier prospect is kept ("first-seen wins", unchanged
 * from the domain-only version). A later prospect matching an already-kept
 * one is no longer silently discarded: it increments the kept prospect's
 * `corroboratingSourceCount` by 1, preserving the fact that a second source
 * independently found the same business (see `priority-scoring.ts`'s
 * corroboration bonus). This is still a deliberately minimal extension (see
 * docs/discovery-engine-roadmap.md item 5) - it does not merge/reconcile
 * signals between matched duplicates, and it is not a scored
 * entity-resolution engine.
 */
function dedupeProspects(prospects: DiscoveredProspect[]): DiscoveredProspect[] {
  const byDomain = new Map<string, DiscoveredProspect>();
  const byPhone = new Map<string, DiscoveredProspect>();
  const byAddress = new Map<string, DiscoveredProspect>();
  const result: DiscoveredProspect[] = [];

  for (const prospect of prospects) {
    const domainKey = prospect.domain ? normalizeDomain(prospect.domain) : null;
    const phoneKey = normalizePhone(prospect.phone);
    const addressKey = normalizeAddress(prospect.address);

    const matched =
      (domainKey !== null ? byDomain.get(domainKey) : undefined) ??
      (phoneKey !== null ? byPhone.get(phoneKey) : undefined) ??
      (addressKey !== null ? byAddress.get(addressKey) : undefined);

    if (matched) {
      matched.corroboratingSourceCount += 1;
      continue;
    }

    result.push(prospect);
    if (domainKey !== null) byDomain.set(domainKey, prospect);
    if (phoneKey !== null) byPhone.set(phoneKey, prospect);
    if (addressKey !== null) byAddress.set(addressKey, prospect);
  }

  return result;
}

/**
 * Finds a previously-persisted prospect matching `prospect`, in the same
 * priority order as `dedupeProspects`: normalized domain first, then
 * normalized phone, then normalized address - first match wins. `phone`/
 * `address` are stored normalized (see `persistProspect`) specifically so
 * this can do a plain exact-match query per key rather than normalizing
 * every row in the table on every discovery run.
 */
async function findExistingProspect(
  prospect: DiscoveredProspect,
  normalizedPhone: string | null,
  normalizedAddress: string | null
) {
  if (prospect.domain) {
    const byDomain = await prisma.prospect.findFirst({ where: { domain: prospect.domain } });
    if (byDomain) return byDomain;
  }

  if (normalizedPhone) {
    const byPhone = await prisma.prospect.findFirst({ where: { phone: normalizedPhone } });
    if (byPhone) return byPhone;
  }

  if (normalizedAddress) {
    const byAddress = await prisma.prospect.findFirst({ where: { address: normalizedAddress } });
    if (byAddress) return byAddress;
  }

  return null;
}

/**
 * Inserts a newly-discovered prospect, or updates the existing one matched
 * by domain/phone/address (see `findExistingProspect`). Per the spec's
 * "doNotContact checked before every send including future re-scraping of
 * the same source": a prospect already marked `doNotContact` (e.g. it
 * previously unsubscribed or replied negatively) is left completely
 * untouched by re-discovery - its `doNotContact` flag is never overwritten
 * back to `false`, and nothing about it (signal, priorityScore, status) is
 * refreshed, so a routine re-scrape can never pull a permanently-opted-out
 * prospect back into the normal discovery/drafting/sending flow.
 */
async function persistProspect(
  prospect: DiscoveredProspect,
  query: DiscoveryQuery
): Promise<'inserted' | 'updated' | 'skipped_do_not_contact'> {
  const normalizedPhone = normalizePhone(prospect.phone);
  const normalizedAddress = normalizeAddress(prospect.address);

  const existing = await findExistingProspect(prospect, normalizedPhone, normalizedAddress);

  if (existing?.doNotContact) {
    return 'skipped_do_not_contact';
  }

  // Monotonic: an already-persisted row's own count is added to (never
  // overwritten by this run's in-memory count, which only reflects sources
  // seen in this one run) - see `Prospect.corroboratingSourceCount`'s doc
  // comment in prisma/schema.prisma.
  const corroboratingSourceCount = existing
    ? existing.corroboratingSourceCount + prospect.corroboratingSourceCount
    : prospect.corroboratingSourceCount;

  const priorityScore = computePriorityScore({ ...prospect, corroboratingSourceCount }, { geography: query.geography });

  // Computed centrally (rather than supplied by each discovery source) so
  // every source shares one matching engine - see service-matching-rules.ts.
  // Recomputed on every persist, insert or update: a re-scrape can upgrade a
  // prospect's signal (e.g. weak -> strong, or a different signal type
  // entirely), and stale suggestions left over from a prior scrape would
  // otherwise silently linger until someone manually hits the /match route.
  const suggestedServices = computeServiceSuggestions({
    signal: prospect.signal,
    companySize: prospect.companySize,
    industry: prospect.industry,
  });
  const { projectFit, estimatedBudget } = deriveProjectFitAndBudget(suggestedServices, prospect.signal);

  if (existing) {
    await prisma.prospect.update({
      where: { id: existing.id },
      data: {
        companyName: prospect.companyName,
        websiteUrl: prospect.websiteUrl,
        signal: prospect.signal,
        priorityScore,
        corroboratingSourceCount,
        location: prospect.location,
        phone: normalizedPhone,
        address: normalizedAddress,
        // Cast needed: see the identical cast on the create() call below -
        // an array of a plain interface doesn't structurally satisfy
        // Prisma's `InputJsonValue`.
        suggestedServices: suggestedServices as unknown as Prisma.InputJsonValue,
        projectFit,
        estimatedBudget,
      },
    });
    return 'updated';
  }

  await prisma.prospect.create({
    data: {
      companyName: prospect.companyName,
      domain: prospect.domain,
      websiteUrl: prospect.websiteUrl,
      industry: prospect.industry,
      location: prospect.location,
      phone: normalizedPhone,
      address: normalizedAddress,
      companySize: toPrismaCompanySize(prospect.companySize),
      // No enrichment/email-finding in this phase yet.
      emailConfidence: 0,
      source: prospect.source,
      sourceUrl: prospect.sourceUrl,
      discoveredAt: prospect.discoveredAt,
      signal: prospect.signal,
      projectFit,
      estimatedBudget,
      // Cast needed: an array of a plain interface (no string index
      // signature) doesn't structurally satisfy Prisma's `InputJsonValue`
      // even though it's valid JSON at runtime - same non-issue `Signal`
      // avoids only because it's a single object, not an array.
      suggestedServices: suggestedServices as unknown as Prisma.InputJsonValue,
      priorityScore,
      corroboratingSourceCount,
    },
  });
  return 'inserted';
}

/**
 * Orchestrates discovery sources for a category+geography query: runs
 * whatever sources are configured for the requested `branch`, dedupes by
 * domain/phone/address (see `dedupeProspects`), computes a weighted priority
 * score (see `priority-scoring.ts`), and persists new/updated prospects.
 * Never fails the whole run because one source lacks an API key - each
 * source's availability and outcome is reported in `sources`.
 *
 * `branch` selects which sources run: `'a'` (default) = local/SMB discovery
 * (Google Places, yellowpages), `'b'` = startup/SaaS discovery (Product
 * Hunt, Crunchbase, Indie Hackers), `'both'` = every source. The
 * `enrichers` chain (tech-stack detector, then BuiltWith, then GitHub)
 * always runs afterward regardless of branch, since it enriches whatever
 * prospects were found rather than discovering its own.
 *
 * `enabledSources`, when provided, further restricts which of the branch's
 * sources actually run (e.g. a user unchecking a paid source in the
 * dashboard before triggering a run) - a source filtered out this way is
 * reported in `sources` as skipped with reason `'disabled for this run'`
 * rather than being called at all. When omitted (as the cron route always
 * omits it), every source for the branch runs, preserving prior behavior.
 */
export async function runDiscovery(
  input: unknown,
  branch: DiscoveryBranch = 'a',
  enabledSources?: string[]
): Promise<DiscoveryRunSummary> {
  const query = discoveryQuerySchema.parse(input);

  const branchSources = DISCOVERY_SOURCES.filter(
    (source) => source.branch !== null && (branch === 'both' || source.branch === branch)
  );

  const sources: SourceRunSummary[] = [];
  let allProspects: DiscoveredProspect[] = [];

  for (const { key } of branchSources) {
    if (enabledSources !== undefined && !enabledSources.includes(key)) {
      sources.push({ source: key, ran: false, reason: 'disabled for this run', count: 0 });
      continue;
    }

    const result = await SOURCE_RUNNERS[key](query);
    if (result.ok) {
      sources.push({ source: key, ran: true, count: result.prospects.length, reason: result.degradedReason });
      allProspects = allProspects.concat(result.prospects);
    } else {
      sources.push({ source: key, ran: false, reason: result.reason, count: 0 });
    }
  }

  // Enrichment-only sources (they need a domain/URL, not a category+geography
  // query) are reported separately from discovery sources, in a fixed order:
  // the free first-party tech-stack detector runs first, then BuiltWith,
  // then GitHub - each later stage naturally acts as a cross-check that can
  // still strengthen the signal, since every enricher applies the same
  // "only upgrade if strictly stronger" comparison (see `enrichWithStaleStack`/
  // `enrichWithTechStackDetector`/`enrichWithGitHub`) against whatever the
  // prior stage left behind. Skip BuiltWith's per-domain lookups entirely
  // (rather than calling and having each one fail identically) when the key
  // isn't configured at all, or when it was filtered out for this run.
  // GitHub needs no required env var (GITHUB_TOKEN is optional - see
  // github.source.ts), so it's unconditionally "configured" unless disabled
  // for this run.
  const builtwithDisabledForRun = enabledSources !== undefined && !enabledSources.includes('builtwith');
  const builtwithConfigured = !builtwithDisabledForRun && env.BUILTWITH_API_KEY !== undefined;
  const githubDisabledForRun = enabledSources !== undefined && !enabledSources.includes('github');

  const enrichers: Array<{ source: string; configured: boolean; reason?: string; enrich: (prospect: DiscoveredProspect) => Promise<EnrichResult> }> = [
    { source: 'tech_stack_detector', configured: true, enrich: enrichWithTechStackDetector },
    {
      source: 'builtwith',
      configured: builtwithConfigured,
      reason: builtwithConfigured
        ? undefined
        : builtwithDisabledForRun
          ? 'disabled for this run'
          : 'source unavailable: BUILTWITH_API_KEY not configured',
      enrich: enrichWithStaleStack,
    },
    {
      source: 'github',
      configured: !githubDisabledForRun,
      reason: githubDisabledForRun ? 'disabled for this run' : undefined,
      enrich: enrichWithGitHubForSaasOnly,
    },
  ];

  let enrichedProspects = allProspects;
  for (const enricher of enrichers) {
    if (!enricher.configured) {
      sources.push({ source: enricher.source, ran: false, reason: enricher.reason, count: 0 });
      continue;
    }

    const results = await Promise.all(enrichedProspects.map(enricher.enrich));
    sources.push({ source: enricher.source, ran: true, count: results.filter((result) => result.enriched).length });
    enrichedProspects = results.map((result) => result.prospect);
  }

  const deduped = dedupeProspects(enrichedProspects);

  // Deliberately filtered AFTER the full enrichment chain, not before: every
  // current enricher (tech-stack detector, BuiltWith, GitHub) requires an
  // existing domain to run at all, so today a domain-less prospect can never
  // actually be "rescued" by enrichment - this ordering has no observable
  // effect yet. It's kept this way anyway so a future enricher that CAN add a
  // domain/phone/address to a bare prospect (e.g. guessing a website from the
  // business name) gets the benefit automatically, without this filter
  // needing to move.
  const actionable = deduped.filter((prospect) => !isThinProspect(prospect));
  const discardedThinProspects = deduped.length - actionable.length;

  let inserted = 0;
  let updated = 0;
  let skippedDoNotContact = 0;
  for (const prospect of actionable) {
    const outcome = await persistProspect(prospect, query);
    if (outcome === 'inserted') inserted += 1;
    else if (outcome === 'updated') updated += 1;
    else skippedDoNotContact += 1;
  }

  const summary: DiscoveryRunSummary = {
    query,
    branch,
    sources,
    totalFound: deduped.length,
    inserted,
    updated,
    skippedDoNotContact,
    discardedThinProspects,
  };

  // Fire-and-record, not fire-and-forget: awaited so a run's history is
  // guaranteed persisted before the caller (cron or dashboard) sees success,
  // but failure here must never fail the discovery run itself - the prospects
  // are already persisted above by this point, so a history-logging error is
  // strictly less important than the run's actual outcome.
  //
  // `discardedThinProspects` is deliberately NOT persisted here - the
  // `DiscoveryRun` model has no column for it (see prisma/schema.prisma),
  // and adding one is a migration out of scope for this change. It's still
  // reported on the live `summary` returned to the caller.
  await prisma.discoveryRun
    .create({
      data: {
        category: query.category,
        geography: query.geography,
        branch,
        totalFound: summary.totalFound,
        inserted: summary.inserted,
        updated: summary.updated,
        skippedDoNotContact: summary.skippedDoNotContact,
        sources: sources as unknown as Prisma.InputJsonValue,
      },
    })
    .catch((error: unknown) => {
      console.error('discoveryRun.create failed - history logging lost for this run', error);
    });

  return summary;
}

/**
 * Returns the most recent discovery runs (search inputs + outcome counts),
 * newest first, so the dashboard can warn against re-running an identical
 * category+geography+branch search.
 */
export async function listRecentDiscoveryRuns(limit = 20): Promise<DiscoveryRun[]> {
  return prisma.discoveryRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
