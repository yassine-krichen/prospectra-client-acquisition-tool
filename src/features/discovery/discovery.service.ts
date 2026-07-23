import { env } from '@/common/config/env';
import { prisma } from '@/common/db/client';
import { discoveryQuerySchema, type DiscoveredProspect, type DiscoveryQuery, type SourceResult } from '@/features/discovery/discovery.types';
import { normalizeDomain } from '@/features/discovery/normalize-domain';
import { runGooglePlacesSource } from '@/features/discovery/sources/google-places.source';
import { lookupStaleStack } from '@/features/discovery/sources/builtwith.source';
import { runYellowPagesSource } from '@/features/discovery/sources/yellowpages.source';
import { toPrismaCompanySize } from '@/features/prospects/company-size.mapper';
import type { Signal, SignalStrength } from '@/features/prospects/prospect.types';

// Stub scoring for this phase — real weighting arrives in Phase 6. For now,
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
  sources: SourceRunSummary[];
  totalFound: number;
  inserted: number;
  updated: number;
}

function computePriorityScore(signal: Signal): number {
  return SIGNAL_STRENGTH_SCORE[signal.strength];
}

/**
 * Enriches a discovered prospect's signal with BuiltWith's tech-stack
 * staleness rules, but only when BuiltWith's signal is at least as strong as
 * whatever the source already found — BuiltWith adds evidence, it shouldn't
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

async function persistProspect(prospect: DiscoveredProspect): Promise<'inserted' | 'updated'> {
  const priorityScore = computePriorityScore(prospect.signal);

  const existing = prospect.domain
    ? await prisma.prospect.findFirst({ where: { domain: prospect.domain } })
    : null;

  if (existing) {
    await prisma.prospect.update({
      where: { id: existing.id },
      data: {
        companyName: prospect.companyName,
        websiteUrl: prospect.websiteUrl,
        signal: prospect.signal,
        priorityScore,
        location: prospect.location,
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
      projectFit: prospect.projectFit,
      estimatedBudget: prospect.estimatedBudget,
      priorityScore,
    },
  });
  return 'inserted';
}

/**
 * Orchestrates all Branch A discovery sources for a category+geography
 * query: runs whatever sources are configured, dedupes by domain, computes a
 * stub priority score, and persists new/updated prospects. Never fails the
 * whole run because one source lacks an API key — each source's
 * availability and outcome is reported in `sources`.
 */
export async function runDiscovery(input: unknown): Promise<DiscoveryRunSummary> {
  const query = discoveryQuerySchema.parse(input);

  const sourceRuns: Array<{ name: string; result: SourceResult }> = [
    { name: 'google_places', result: await runGooglePlacesSource(query) },
    { name: 'yellowpages', result: await runYellowPagesSource(query) },
  ];

  const sources: SourceRunSummary[] = [];
  let allProspects: DiscoveredProspect[] = [];

  for (const { name, result } of sourceRuns) {
    if (result.ok) {
      sources.push({ source: name, ran: true, count: result.prospects.length });
      allProspects = allProspects.concat(result.prospects);
    } else {
      sources.push({ source: name, ran: false, reason: result.reason, count: 0 });
    }
  }

  // BuiltWith is enrichment-only (it needs a domain, not a category+geography
  // query), so it's reported separately rather than as a discovery source.
  // Skip the per-domain lookups entirely (rather than calling and having
  // each one fail identically) when the key isn't configured at all.
  const builtwithConfigured = env.BUILTWITH_API_KEY !== undefined;
  const enrichmentResults = builtwithConfigured
    ? await Promise.all(allProspects.map(enrichWithStaleStack))
    : allProspects.map((prospect) => ({ prospect, enriched: false }));

  sources.push({
    source: 'builtwith',
    ran: builtwithConfigured,
    reason: builtwithConfigured ? undefined : 'source unavailable: BUILTWITH_API_KEY not configured',
    count: enrichmentResults.filter((result) => result.enriched).length,
  });

  const enriched = enrichmentResults.map((result) => result.prospect);
  const deduped = dedupeByDomain(enriched);

  let inserted = 0;
  let updated = 0;
  for (const prospect of deduped) {
    const outcome = await persistProspect(prospect);
    if (outcome === 'inserted') inserted += 1;
    else updated += 1;
  }

  return { query, sources, totalFound: deduped.length, inserted, updated };
}
