import { z } from 'zod';

import {
  companySizeSchema,
  industrySchema,
  signalStrengthSchema,
  signalTypeSchema,
} from '@/features/prospects/prospect.types';

// One JSONL line the headless `claude` agent outputs per candidate prospect -
// see prompt-template.ts's output contract, which spells out this exact key
// list for the agent. Deliberately flatter than `DiscoveredProspect` (no
// nested `location`/`signal` objects) since it's easier for the agent to
// produce a flat JSON object reliably - `map-to-discovered-prospect.ts`
// reshapes this into the pipeline's real shape.
export const agenticProspectLineSchema = z.object({
  companyName: z.string().min(1),
  domain: z.string().min(1).nullable(),
  websiteUrl: z.string().url().nullable(),
  industry: industrySchema,
  companySize: companySizeSchema,
  city: z.string().min(1).nullable(),
  country: z.string().min(1).nullable(),
  phone: z.string().min(1).nullable(),
  address: z.string().min(1).nullable(),
  signalType: signalTypeSchema,
  signalStrength: signalStrengthSchema,
  signalDescription: z.string().min(1),
  evidenceUrl: z.string().url(),
  evidenceSummary: z.string().min(1),
  secondarySignal: z.string().min(1).nullable(),
});
export type AgenticProspectLine = z.infer<typeof agenticProspectLineSchema>;
