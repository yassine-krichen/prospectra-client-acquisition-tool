import { z } from 'zod';

import {
  companySizeSchema,
  industrySchema,
  signalStrengthSchema,
  signalTypeSchema,
} from '@/features/prospects/prospect.types';

// The agent output is untrusted: only http(s) URLs may reach the DB or the
// operator-facing report (rules out javascript:/file:/data: schemes).
const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'URL must use http or https' });

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
  evidenceUrl: httpUrlSchema,
  evidenceSummary: z.string().min(1),
  secondarySignal: z.string().min(1).nullable(),
  // Outreach contact, optional so older/Khalid-track lines without it still
  // validate. `emailSource` records whether the address was seen on a fetched
  // page ('published') or inferred from a pattern ('guessed') so the operator
  // knows which ones to double-check before sending.
  contactName: z.string().min(1).nullable().default(null),
  contactRole: z.string().min(1).nullable().default(null),
  contactEmail: z.string().email().nullable().default(null),
  emailSource: z.enum(['published', 'guessed', 'none']).default('none'),
  contactPageUrl: httpUrlSchema.nullable().default(null),
  pitchAngle: z.string().min(1).nullable().default(null),
});
export type AgenticProspectLine = z.infer<typeof agenticProspectLineSchema>;
