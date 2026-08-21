import { Prisma } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { computeServiceSuggestions, deriveProjectFitAndBudget, type ServiceSuggestion } from '@/features/matching/service-matching-rules';
import { fromPrismaCompanySize } from '@/features/prospects/company-size.mapper';
import { signalSchema } from '@/features/prospects/prospect.types';

// Orchestrates the pure rules engine (`service-matching-rules.ts`) against a
// persisted Prospect: reads it, validates its stored `signal` (same
// validation followup-scheduler.ts already runs before trusting it), and
// persists the derived `suggestedServices`/`projectFit`/`estimatedBudget`.

const PROSPECT_SELECT = {
  id: true,
  signal: true,
  companySize: true,
  industry: true,
} as const satisfies Prisma.ProspectSelect;

export type MatchingOutcome =
  | { outcome: 'applied'; prospectId: string; suggestedServices: ServiceSuggestion[] }
  | { outcome: 'not_found'; prospectId: string }
  | { outcome: 'invalid_signal'; prospectId: string; reason: string };

/**
 * Recomputes and persists a Prospect's service suggestions. Called at
 * discovery/enrichment time and via the manual `/match` route (a dashboard
 * "Recompute suggestions" button). Never throws on a malformed stored
 * `signal` - returns `invalid_signal` instead, since `signal` is an
 * untyped `Json` column this app only ever writes in the validated shape,
 * but never assumes that on read (see prospect.types.ts's header comment).
 */
export async function applyServiceMatching(prospectId: string): Promise<MatchingOutcome> {
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId }, select: PROSPECT_SELECT });
  if (!prospect) return { outcome: 'not_found', prospectId };

  const signalResult = signalSchema.safeParse(prospect.signal);
  if (!signalResult.success) {
    return { outcome: 'invalid_signal', prospectId, reason: signalResult.error.message };
  }

  const signal = signalResult.data;
  const companySize = fromPrismaCompanySize(prospect.companySize);

  const suggestedServices = computeServiceSuggestions({ signal, companySize, industry: prospect.industry });
  const { projectFit, estimatedBudget } = deriveProjectFitAndBudget(suggestedServices, signal);

  await prisma.prospect.update({
    where: { id: prospectId },
    // Cast needed: an array of a plain interface (no string index
    // signature) doesn't structurally satisfy Prisma's `InputJsonValue`
    // even though it's valid JSON at runtime.
    data: { suggestedServices: suggestedServices as unknown as Prisma.InputJsonValue, projectFit, estimatedBudget },
  });

  return { outcome: 'applied', prospectId, suggestedServices };
}
