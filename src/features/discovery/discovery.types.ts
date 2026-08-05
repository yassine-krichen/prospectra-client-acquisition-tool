import { z } from 'zod';

import type { CompanySize, Industry, Location, ProspectSource, Signal } from '@/features/prospects/prospect.types';

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
});
export type DiscoverRequest = z.infer<typeof discoverRequestSchema>;

// The subset of the `Prospect` shape a discovery source can populate on its
// own. The orchestrator fills in the rest (id, priorityScore persistence,
// status, etc) once results are deduped — including `projectFit`/
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
});
export type DiscoveryRunSummary = z.infer<typeof discoveryRunSummarySchema>;
