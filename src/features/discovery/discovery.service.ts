import type { DiscoveryRun, Prisma } from '@/lib/generated/prisma/client';
import { env } from '@/common/config/env';
import { prisma } from '@/common/db/client';
import { discoveryQuerySchema, type DiscoveredProspect, type DiscoveryQuery, type SourceResult } from '@/features/discovery/discovery.types';
import { DISCOVERY_SOURCES } from '@/features/discovery/discovery-source-registry';
import { normalizeDomain } from '@/features/discovery/normalize-domain';
import { runGooglePlacesSource } from '@/features/discovery/sources/google-places.source';
import { lookupStaleStack } from '@/features/discovery/sources/builtwith.source';
import { runYellowPagesSource } from '@/features/discovery/sources/yellowpages.source';
import { runProductHuntSource } from '@/features/discovery/sources/product-hunt.source';
import { runCrunchbaseSource } from '@/features/discovery/sources/crunchbase.source';
import { runGitHubSource } from '@/features/discovery/sources/github.source';
import { runIndieHackersSource } from '@/features/discovery/sources/indiehackers.source';
import { computeServiceSuggestions, deriveProjectFitAndBudget } from '@/features/matching/service-matching-rules';
import { toPrismaCompanySize } from '@/features/prospects/company-size.mapper';
import type { Signal, SignalStrength } from '@/features/prospects/prospect.types';

// Branch A = local/SMB discovery (category+geography search: Google Places,
// yellowpages). Branch B = startup/SaaS discovery (topic/recency-based:
// Product Hunt, Crunchbase, GitHub, Indie Hackers) - same `DiscoveryQuery`
// shape is reused (`category` doubles as a topic/keyword filter, and
// `geography` is mostly ignored by Branch B sources - see each source's own
// doc comment), so both branches share one orchestrator and one query type
// rather than duplicating the discovery pipeline.
export type DiscoveryBranch = 'a' | 'b' | 'both';

// Stub scoring for this phase - real weighting arrives in Phase 7. For now,
// priority is just the strength of the single strongest signal found.
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
}

// Maps each registry source key to the function that actually runs it.
// Built once here rather than duplicating a giant if/else per branch - see
// `runDiscovery`'s loop over `DISCOVERY_SOURCES`.
const SOURCE_RUNNERS: Record<string, (query: DiscoveryQuery) => Promise<SourceResult>> = {
  google_places: runGooglePlacesSource,
  yellowpages: runYellowPagesSource,
  product_hunt: runProductHuntSource,
  crunchbase: runCrunchbaseSource,
  github: runGitHubSource,
  indiehackers: runIndieHackersSource,
};

function computePriorityScore(signal: Signal): number {
  return SIGNAL_STRENGTH_SCORE[signal.strength];
}

/**
 * Enriches a discovered prospect's signal with BuiltWith's tech-stack
 * staleness rules, but only when BuiltWith's signal is at least as strong as
 * whatever the source already found - BuiltWith adds evidence, it shouldn't
 * downgrade a stronger signal a source already detected.
 */
async function enrichWithStaleStack(
  prospect: DiscoveredProspect
): Promise<{ prospect: DiscoveredProspect; enriched: boolean }> {
  if (!prospect.domain) return { prospect, enriched: false };

  const staleStack = await lookupStaleStack(prospect.domain);
  if (!staleStack.ok || !staleStack.lookup.signal) return { prospect, enriched: false };

  const existingScore = SIGNAL_STRENGTH_SCORE[prospect.signal.strength];
  const staleStackScore = SIGNAL_STRENGTH_SCORE[staleStack.lookup.signal.strength];
  if (staleStackScore <= existingScore) return { prospect, enriched: false };

  return { prospect: { ...prospect, signal: staleStack.lookup.signal }, enriched: true };
}

function dedupeByDomain(prospects: DiscoveredProspect[]): DiscoveredProspect[] {
  const seen = new Map<string, DiscoveredProspect>();
  let noDomainCount = 0;

  for (const prospect of prospects) {
    const key = prospect.domain ? normalizeDomain(prospect.domain) : `__no-domain-${noDomainCount++}`;
    if (!seen.has(key)) {
      seen.set(key, prospect);
    }
  }

  return Array.from(seen.values());
}

/**
 * Inserts a newly-discovered prospect, or updates the existing one matched
 * by `domain`. Per the spec's "doNotContact checked before every send
 * including future re-scraping of the same source": a prospect already
 * marked `doNotContact` (e.g. it previously unsubscribed or replied
 * negatively) is left completely untouched by re-discovery - its
 * `doNotContact` flag is never overwritten back to `false`, and nothing
 * about it (signal, priorityScore, status) is refreshed, so a routine
 * re-scrape can never pull a permanently-opted-out prospect back into the
 * normal discovery/drafting/sending flow.
 */
async function persistProspect(prospect: DiscoveredProspect): Promise<'inserted' | 'updated' | 'skipped_do_not_contact'> {
  const priorityScore = computePriorityScore(prospect.signal);

  const existing = prospect.domain
    ? await prisma.prospect.findFirst({ where: { domain: prospect.domain } })
    : null;

  if (existing?.doNotContact) {
    return 'skipped_do_not_contact';
  }

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
        location: prospect.location,
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
    },
  });
  return 'inserted';
}

/**
 * Orchestrates discovery sources for a category+geography query: runs
 * whatever sources are configured for the requested `branch`, dedupes by
 * domain, computes a stub priority score, and persists new/updated
 * prospects. Never fails the whole run because one source lacks an API
 * key - each source's availability and outcome is reported in `sources`.
 *
 * `branch` selects which sources run: `'a'` (default) = local/SMB discovery
 * (Google Places, yellowpages), `'b'` = startup/SaaS discovery (Product
 * Hunt, Crunchbase, GitHub, Indie Hackers), `'both'` = every source. BuiltWith
 * enrichment always runs afterward regardless of branch, since it enriches
 * whatever prospects were found rather than discovering its own.
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

  // BuiltWith is enrichment-only (it needs a domain, not a category+geography
  // query), so it's reported separately rather than as a discovery source.
  // Skip the per-domain lookups entirely (rather than calling and having
  // each one fail identically) when the key isn't configured at all, or when
  // it was filtered out for this run.
  const builtwithDisabledForRun = enabledSources !== undefined && !enabledSources.includes('builtwith');
  const builtwithConfigured = !builtwithDisabledForRun && env.BUILTWITH_API_KEY !== undefined;
  const enrichmentResults = builtwithConfigured
    ? await Promise.all(allProspects.map(enrichWithStaleStack))
    : allProspects.map((prospect) => ({ prospect, enriched: false }));

  sources.push({
    source: 'builtwith',
    ran: builtwithConfigured,
    reason: builtwithConfigured
      ? undefined
      : builtwithDisabledForRun
        ? 'disabled for this run'
        : 'source unavailable: BUILTWITH_API_KEY not configured',
    count: enrichmentResults.filter((result) => result.enriched).length,
  });

  const enriched = enrichmentResults.map((result) => result.prospect);
  const deduped = dedupeByDomain(enriched);

  let inserted = 0;
  let updated = 0;
  let skippedDoNotContact = 0;
  for (const prospect of deduped) {
    const outcome = await persistProspect(prospect);
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
  };

  // Fire-and-record, not fire-and-forget: awaited so a run's history is
  // guaranteed persisted before the caller (cron or dashboard) sees success,
  // but failure here must never fail the discovery run itself - the prospects
  // are already persisted above by this point, so a history-logging error is
  // strictly less important than the run's actual outcome.
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
