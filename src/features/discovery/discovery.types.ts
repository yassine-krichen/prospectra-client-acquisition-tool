import { z } from 'zod';

import type {
  CompanySize,
  EstimatedBudget,
  Industry,
  Location,
  ProjectFit,
  ProspectSource,
  Signal,
} from '@/features/prospects/prospect.types';

// A category + geography search input shared by every Branch A discovery
// source (e.g. category: "plumber", geography: "Austin, TX").
export const discoveryQuerySchema = z.object({
  category: z.string().min(1),
  geography: z.string().min(1),
});
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;

// The subset of the `Prospect` shape a discovery source can populate on its
// own. The orchestrator fills in the rest (id, priorityScore persistence,
// status, etc) once results are deduped.
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
  projectFit: ProjectFit;
  estimatedBudget: EstimatedBudget;
}

export interface SourceUnavailable {
  ok: false;
  /** Human-readable reason, e.g. "source unavailable: X_API_KEY not configured". */
  reason: string;
}

export interface SourceRunSuccess {
  ok: true;
  prospects: DiscoveredProspect[];
}

// Every discovery source returns this shape instead of throwing, so a
// missing API key or a failed request degrades to "skipped, here's why"
// rather than crashing the whole discovery run.
export type SourceResult = SourceRunSuccess | SourceUnavailable;
