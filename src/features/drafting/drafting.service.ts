import { ModelUsed as PrismaModelUsed, ProspectStatus as PrismaProspectStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { humanize } from '@/features/drafting/claude-bridge.client';
import { fromPrismaModelUsed, toPrismaModelUsed } from '@/features/drafting/model-used.mapper';
import { generateDraftWithFallback } from '@/features/drafting/model-rotation';
import { buildDraftPrompt, sampleFrameworks } from '@/features/drafting/prompt-templates';
import { validateDraftOutput } from '@/features/drafting/validate-draft-output';
import { signalSchema } from '@/features/prospects/prospect.types';
import type { Draft, EstimatedBudget, Industry, ProjectFit } from '@/features/prospects/prospect.types';
import type {
  DraftingProvider,
  DraftProspectOutcome,
  HumanizeBatchItemResult,
  HumanizeBatchSummary,
  HumanizeOutcomeSummary,
} from '@/features/drafting/drafting.types';

// Signal strength is currently scored 1 (weak) - 3 (strong) as a Phase 3
// stub (see discovery.service.ts's `SIGNAL_STRENGTH_SCORE` /
// `computePriorityScore` - "real weighting arrives in Phase 6"). Until that
// real scoring lands, "HIGH priorityScore" means the top of that stub
// scale: a `strong` signal. Revisit this constant once Phase 6 replaces the
// stub with weighted scoring.
export const HIGH_PRIORITY_THRESHOLD = 3;

// Exactly 3 variants per prospect, per the spec.
const VARIANT_COUNT = 3;

// Prospects pulled per `draftBatch` cron invocation. Drafting itself isn't
// rate-limited the way the humanizer pass is, but batches stay bounded so a
// single cron invocation can't run unbounded against Gemini/Groq.
export const DRAFT_BATCH_SIZE = 10;

// Drafts humanized per `humanizeBatch` cron invocation. Conservative given
// claude-bridge's real ~40-messages/8-hour window, SHARED across every
// caller (high-priority prospects humanized inline by `draftProspect`, any
// other process hitting the same bridge, and this cron potentially running
// several times before the window resets) - 5 keeps a wide safety margin
// rather than assuming this cron run has the whole budget to itself.
export const HUMANIZE_BATCH_SIZE = 5;

const PROSPECT_SELECT = {
  id: true,
  companyName: true,
  contactName: true,
  contactTitle: true,
  industry: true,
  projectFit: true,
  estimatedBudget: true,
  signal: true,
  priorityScore: true,
  status: true,
  statusHistory: true,
} as const;

interface ProspectRow {
  id: string;
  companyName: string;
  contactName: string | null;
  contactTitle: string | null;
  industry: Industry;
  projectFit: ProjectFit;
  estimatedBudget: EstimatedBudget;
  signal: unknown;
  priorityScore: number;
  status: PrismaProspectStatus;
  statusHistory: unknown;
}

interface DraftRow {
  id: string;
  prospectId: string;
  variant: number;
  subject: string;
  body: string;
  humanizedBody: string | null;
  modelUsed: PrismaModelUsed;
  framework: string | null;
  generatedAt: Date;
  edited: boolean;
  approved: boolean;
}

type ValidatedDraftResult =
  | { ok: true; subject: string; body: string; modelUsed: DraftingProvider }
  | { ok: false; flagged: 'no_llm_available' | 'invalid_draft_output'; reason: string };

/**
 * Wraps `generateDraftWithFallback` with a post-generation check against
 * `validateDraftOutput`'s hard constraints (word count, banned phrases) -
 * prompt-templates.ts only asks the model for these as instructions, and
 * models don't always comply. A validation failure is treated the same way
 * as a provider failure: retried once through the same rotation/failover
 * path (which rotates which provider goes first - see model-rotation.ts),
 * giving the other provider a chance to produce compliant output, rather
 * than silently persisting a non-compliant draft as if it met every
 * constraint. If the retry is also non-compliant, this reports failure so
 * the caller flags the prospect instead of persisting anything for it -
 * consistent with `draftProspect`'s existing "generated all-or-nothing"
 * behavior for a `no_llm_available` failure. `isHighPriority` is threaded
 * straight through to `generateDraftWithFallback`, which only attempts its
 * scarce claude-bridge tier-2 lane for high-priority prospects - see that
 * function's doc comment in model-rotation.ts.
 */
async function generateValidatedDraft(prompt: string, isHighPriority: boolean): Promise<ValidatedDraftResult> {
  const first = await generateDraftWithFallback(prompt, { isHighPriority });
  if (!first.ok) return { ok: false, flagged: 'no_llm_available', reason: first.reason };
  if (validateDraftOutput(first).valid) return first;

  const retry = await generateDraftWithFallback(prompt, { isHighPriority });
  if (!retry.ok) return { ok: false, flagged: 'no_llm_available', reason: retry.reason };
  const retryValidation = validateDraftOutput(retry);
  if (retryValidation.valid) return retry;

  return {
    ok: false,
    flagged: 'invalid_draft_output',
    reason: `generated draft failed post-generation validation twice: ${retryValidation.reasons.join('; ')}`,
  };
}

function toDraftView(row: DraftRow): Draft {
  return {
    id: row.id,
    prospectId: row.prospectId,
    variant: row.variant,
    subject: row.subject,
    body: row.body,
    humanizedBody: row.humanizedBody,
    modelUsed: fromPrismaModelUsed(row.modelUsed),
    framework: row.framework,
    generatedAt: row.generatedAt,
    edited: row.edited,
    approved: row.approved,
  };
}

/**
 * Drafts exactly `VARIANT_COUNT` variants for one prospect, refusing to
 * draft (and flagging the prospect instead of throwing) if either its
 * signal is missing/invalid or no LLM provider is available. Runs a
 * humanizer pass only on the prospect's primary (variant 1) draft, and only
 * when `priorityScore` is HIGH (`>= HIGH_PRIORITY_THRESHOLD`) - see this
 * module's doc comment on `HUMANIZE_BATCH_SIZE` for why the shared
 * claude-bridge budget rules out humanizing every variant of every
 * prospect. Lower-priority prospects' variant-1 drafts are picked up later
 * by `humanizeBatch`. A claude-bridge failure/rate-limit never fails the
 * prospect's drafting: `humanizedBody` is simply left `null` and the
 * outcome is reported in the returned `humanize` summary, while
 * `status` still advances `enriched -> drafted` - humanizing is a quality
 * layer on top of drafting, not a blocker for the drafted state.
 *
 * Returns `null` if no prospect exists with `prospectId` (the caller maps
 * that to a 404), matching `enrichProspect`'s convention.
 */
export async function draftProspect(prospectId: string): Promise<DraftProspectOutcome | null> {
  const existing = (await prisma.prospect.findUnique({
    where: { id: prospectId },
    select: PROSPECT_SELECT,
  })) as ProspectRow | null;

  if (!existing) return null;

  const signalResult = signalSchema.safeParse(existing.signal);
  if (!signalResult.success) {
    return {
      ok: false,
      flagged: 'missing_signal',
      message:
        'prospect has no valid signal on file - drafting requires signal.description/evidence as the one allowed observation',
    };
  }

  const prospectData = {
    companyName: existing.companyName,
    contactName: existing.contactName,
    contactTitle: existing.contactTitle,
    industry: existing.industry,
    projectFit: existing.projectFit,
    estimatedBudget: existing.estimatedBudget,
    signal: signalResult.data,
  };

  const isHighPriority = existing.priorityScore >= HIGH_PRIORITY_THRESHOLD;

  // Each variant gets its own distinct copywriting framework - sampled
  // without replacement so a prospect never gets the same narrative angle
  // twice - and therefore its own distinct prompt (see prompt-templates.ts's
  // `sampleFrameworks`/`buildDraftPrompt`), rather than 3 independent samples
  // of one shared prompt.
  const frameworkIds = sampleFrameworks(VARIANT_COUNT);

  // Generated all-or-nothing: if any of the `VARIANT_COUNT` calls comes back
  // "no LLM available" (or fails validation twice - see
  // `generateValidatedDraft`), every subsequent call would very likely fail
  // the same way, so there's no value in persisting a partially-drafted
  // prospect - flag it instead.
  const generations: Array<{ subject: string; body: string; modelUsed: DraftingProvider; framework: string }> = [];
  for (const frameworkId of frameworkIds) {
    const prompt = buildDraftPrompt(prospectData, frameworkId);
    const result = await generateValidatedDraft(prompt, isHighPriority);
    if (!result.ok) {
      return { ok: false, flagged: result.flagged, message: result.reason };
    }
    generations.push({ ...result, framework: frameworkId });
  }

  let humanizedFirstVariant: string | null = null;
  let humanizeOutcome: HumanizeOutcomeSummary = { attempted: false };

  if (isHighPriority) {
    const humanizeResult = await humanize(generations[0].body);
    if (humanizeResult.ok) {
      humanizedFirstVariant = humanizeResult.text;
      humanizeOutcome = { attempted: true, outcome: 'humanized' };
    } else if (humanizeResult.kind === 'rate_limited') {
      humanizeOutcome = { attempted: true, outcome: 'deferred', reason: humanizeResult.reason };
    } else {
      humanizeOutcome = { attempted: true, outcome: 'failed', reason: humanizeResult.reason };
    }
  }

  const statusHistory = Array.isArray(existing.statusHistory) ? existing.statusHistory : [];
  const nextStatus = PrismaProspectStatus.drafted;
  const nextStatusHistory =
    existing.status !== nextStatus
      ? [...statusHistory, { status: nextStatus, timestamp: new Date().toISOString() }]
      : statusHistory;

  const createdRows = await prisma.$transaction(async (tx) => {
    const rows: DraftRow[] = [];
    for (let i = 0; i < generations.length; i += 1) {
      const generation = generations[i];
      const row = await tx.draft.create({
        data: {
          prospectId,
          variant: i + 1,
          subject: generation.subject,
          body: generation.body,
          humanizedBody: i === 0 ? humanizedFirstVariant : null,
          modelUsed: toPrismaModelUsed(generation.modelUsed),
          framework: generation.framework,
        },
      });
      rows.push(row);
    }

    await tx.prospect.update({
      where: { id: prospectId },
      data: { status: nextStatus, statusHistory: nextStatusHistory },
    });

    return rows;
  });

  return { ok: true, drafts: createdRows.map(toDraftView), humanize: humanizeOutcome };
}

/**
 * Runs `draftProspect` for up to `limit` `enriched`-status prospects
 * (highest `priorityScore` first), for the draft-batch cron's part (a).
 */
export async function draftBatch(limit: number = DRAFT_BATCH_SIZE): Promise<
  Array<{ prospectId: string; outcome: DraftProspectOutcome }>
> {
  const candidates = await prisma.prospect.findMany({
    where: { status: PrismaProspectStatus.enriched },
    select: { id: true },
    take: limit,
    orderBy: { priorityScore: 'desc' },
  });

  const results: Array<{ prospectId: string; outcome: DraftProspectOutcome }> = [];
  for (const { id } of candidates) {
    const outcome = await draftProspect(id);
    if (outcome) results.push({ prospectId: id, outcome });
  }
  return results;
}

/**
 * Humanizer pass for previously-drafted prospects whose primary (variant 1)
 * draft doesn't yet have a `humanizedBody` - the draft-batch cron's part
 * (b), respecting `HUMANIZE_BATCH_SIZE`. Only variant 1 is ever considered
 * (see `draftProspect`'s doc comment).
 *
 * Deliberately does NOT exclude high-priority prospects (unlike the rest of
 * this module's high/low-priority split): `draftProspect` already attempts
 * an inline humanize pass for a high-priority prospect, but that attempt can
 * come back `deferred` (rate-limited) or `failed`, leaving `humanizedBody`
 * `null` with nothing else ever retrying it. Ordering by `priorityScore`
 * descending (then oldest-first) means a stranded high-priority draft is
 * retried ahead of lower-priority ones within the same batch, without
 * needing a separate query/cap for it.
 *
 * Stops the batch at the first non-success outcome instead of continuing to
 * the next draft: a rate limit, a logged-out bridge session, or an
 * unreachable bridge all mean every subsequent call this run would almost
 * certainly hit the same wall, so continuing would just burn further calls
 * against a budget/bridge already known to be unavailable this run.
 */
export async function humanizeBatch(limit: number = HUMANIZE_BATCH_SIZE): Promise<HumanizeBatchSummary> {
  const candidates = await prisma.draft.findMany({
    where: {
      variant: 1,
      humanizedBody: null,
      prospect: { status: PrismaProspectStatus.drafted },
    },
    take: limit,
    orderBy: [{ prospect: { priorityScore: 'desc' } }, { generatedAt: 'asc' }],
  });

  const results: HumanizeBatchItemResult[] = [];

  for (const draft of candidates) {
    const result = await humanize(draft.body);

    if (result.ok) {
      await prisma.draft.update({ where: { id: draft.id }, data: { humanizedBody: result.text } });
      results.push({ draftId: draft.id, outcome: 'humanized' });
      continue;
    }

    results.push({ draftId: draft.id, outcome: 'stopped', reason: result.reason });
    break;
  }

  return { attempted: results.length, results };
}
