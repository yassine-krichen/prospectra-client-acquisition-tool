import { z } from 'zod';

import { DISCOVERY_SOURCES } from '@/features/discovery/discovery-source-registry';
import type { CompanySize, Industry, Location, ProspectSource, Signal } from '@/features/prospects/prospect.types';

const DISCOVERY_SOURCE_KEYS = DISCOVERY_SOURCES.map((source) => source.key) as [string, ...string[]];

// A category + geography search input shared by every Branch A discovery
// source (e.g. category: "plumber", geography: "Austin, TX").
export const discoveryQuerySchema = z.object({
  category: z.string().min(1),
  geography: z.string().min(1),
});
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;

// `branch` selects which discovery sources run: 'a' (the default, preserving
// prior behavior) = local/SMB sources, 'b' = startup/SaaS sources, 'both' =
// every source. See `discovery.service.ts`'s `runDiscovery` doc comment for
// what each branch includes. Shared by the cron and dashboard-triggered
// discovery routes so the request shape is defined exactly once.
export const discoverRequestSchema = discoveryQuerySchema.extend({
  branch: z.enum(['a', 'b', 'both']).default('a'),
  // Which sources to actually run for this request, filtered by `branch` -
  // see `runDiscovery`'s `enabledSources` parameter. Omitted (the cron
  // route never sends this) means "run every source for the branch",
  // preserving prior behavior.
  sources: z.array(z.enum(DISCOVERY_SOURCE_KEYS)).optional(),
});
export type DiscoverRequest = z.infer<typeof discoverRequestSchema>;

// The subset of the `Prospect` shape a discovery source can populate on its
// own. The orchestrator fills in the rest (id, priorityScore persistence,
// status, etc) once results are deduped - including `projectFit`/
// `estimatedBudget`, which are computed centrally from `signal`/
// `companySize`/`industry` by the matching engine at persist time
// (`service-matching-rules.ts`) rather than supplied by each source.
export interface DiscoveredProspect {
  companyName: string;
  domain: string | null;
  websiteUrl: string | null;
  industry: Industry;
  location: Location;
  companySize: CompanySize;
  source: ProspectSource;
  sourceUrl: string;
  discoveredAt: Date;
  signal: Signal;
  /** Secondary dedupe key for prospects with no domain - see
   * discovery.service.ts's `dedupeProspects`/`persistProspect`. */
  phone: string | null;
  /** Secondary dedupe key for prospects with no domain - see
   * discovery.service.ts's `dedupeProspects`/`persistProspect`. */
  address: string | null;
  /** How many independent sources have found this business - starts at 1
   * for a freshly-discovered prospect, incremented by `dedupeProspects` when
   * a later prospect in the same run matches it, and further incremented in
   * `persistProspect` against a previously-persisted row's own count. See
   * `Prospect.corroboratingSourceCount` in prisma/schema.prisma and
   * `priority-scoring.ts`'s corroboration bonus. */
  corroboratingSourceCount: number;
}

export interface SourceUnavailable {
  ok: false;
  /** Human-readable reason, e.g. "source unavailable: X_API_KEY not configured". */
  reason: string;
}

export interface SourceRunSuccess {
  ok: true;
  prospects: DiscoveredProspect[];
  /**
   * Set when a source returned partial results because it self-limited
   * mid-run (e.g. github.source.ts stopping early to avoid exhausting
   * GitHub's unauthenticated rate limit) rather than because it was
   * unavailable outright.
   */
  degradedReason?: string;
}

// Every discovery source returns this shape instead of throwing, so a
// missing API key or a failed request degrades to "skipped, here's why"
// rather than crashing the whole discovery run.
export type SourceResult = SourceRunSuccess | SourceUnavailable;

// Zod mirrors of `SourceRunSummary`/`DiscoveryRunSummary` in
// discovery.service.ts, duplicated here (not imported) so client components
// (e.g. discovery-trigger-form.tsx) can validate a discovery run's response
// without pulling in discovery.service.ts, which imports `@/common/config/env`
// and `@/common/db/client`.
export const sourceRunSummarySchema = z.object({
  source: z.string(),
  ran: z.boolean(),
  reason: z.string().optional(),
  count: z.number().int(),
});
export type SourceRunSummary = z.infer<typeof sourceRunSummarySchema>;

export const discoveryRunSummarySchema = z.object({
  query: discoveryQuerySchema,
  branch: z.enum(['a', 'b', 'both']),
  sources: z.array(sourceRunSummarySchema),
  totalFound: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  skippedDoNotContact: z.number().int(),
  // Not persisted on the `DiscoveryRun` model (see discovery.service.ts's
  // `runDiscovery` doc comment) - only present on the live run summary
  // returned to the caller, not on history entries loaded from the DB
  // (see `discoveryRunHistoryEntrySchema` below, which has no such field).
  discardedThinProspects: z.number().int(),
});
export type DiscoveryRunSummary = z.infer<typeof discoveryRunSummarySchema>;

// `POST /api/pipeline/discover` streams newline-delimited JSON instead of a
// single response body, so the dashboard's console panel can show each step
// as it happens rather than only the final summary - see that route and
// discovery-trigger-form.tsx. `discoveryProgressEventSchema` mirrors
// `DiscoveryProgressEvent` in discovery.service.ts, same "client-safe
// duplicate" reasoning as `discoveryRunSummarySchema` above.
export const discoveryProgressEventSchema = z.object({
  level: z.enum(['info', 'success', 'warn']),
  message: z.string(),
});
export type DiscoveryProgressEvent = z.infer<typeof discoveryProgressEventSchema>;

export const discoveryStreamLineSchema = z.discriminatedUnion('type', [
  discoveryProgressEventSchema.extend({ type: z.literal('progress') }),
  z.object({ type: z.literal('summary'), summary: discoveryRunSummarySchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type DiscoveryStreamLine = z.infer<typeof discoveryStreamLineSchema>;

// Client-safe mirror of the `DiscoveryRun` Prisma model (discovery.service.ts's
// `listRecentDiscoveryRuns`), duplicated here for the same reason as
// `discoveryRunSummarySchema` above: client components validate the
// `GET /api/discovery/runs` response without importing `discovery.service.ts`
// (which pulls in `@/common/config/env` and `@/common/db/client`).
export const discoveryRunHistoryEntrySchema = z.object({
  id: z.string(),
  category: z.string(),
  geography: z.string(),
  branch: z.enum(['a', 'b', 'both']),
  totalFound: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  skippedDoNotContact: z.number().int(),
  sources: z.array(sourceRunSummarySchema),
  createdAt: z.coerce.date(),
});
export type DiscoveryRunHistoryEntry = z.infer<typeof discoveryRunHistoryEntrySchema>;

export const discoveryRunHistorySchema = z.array(discoveryRunHistoryEntrySchema);
