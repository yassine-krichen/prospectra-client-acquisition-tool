import type {
  Draft,
  EstimatedBudget,
  Industry,
  ProjectFit,
  Signal,
} from '@/features/prospects/prospect.types';

// Shared shapes for Stage 2 drafting (prompt building, LLM routing, the
// humanizer pass), mirroring discovery.types.ts / enrichment.types.ts:
// every LLM call returns a typed `ok:false` instead of throwing, so one
// provider being unavailable/erroring never crashes the drafting run.

// Draftable subset of `Prospect` — same "explicit projection" pattern as
// `PROSPECT_SELECT` in enrichment.service.ts / `LIST_ITEM_SELECT` in
// prospects.repository.ts. `signal` is required here (not the nullable-in-
// practice value on the raw DB row) — `drafting.service.ts` only builds this
// once it has already validated the raw JSON column really holds a `Signal`.
export interface DraftableProspect {
  companyName: string;
  contactName: string | null;
  contactTitle: string | null;
  industry: Industry;
  projectFit: ProjectFit;
  estimatedBudget: EstimatedBudget;
  signal: Signal;
}

export interface DraftGenerationSuccess {
  ok: true;
  subject: string;
  body: string;
}

export interface DraftGenerationFailure {
  ok: false;
  /** Human-readable reason, e.g. "gemini responded with 429". */
  reason: string;
}

// Returned by each provider client (gemini.client.ts / groq.client.ts) for a
// single generation attempt against an already-selected API key.
export type DraftGenerationResult = DraftGenerationSuccess | DraftGenerationFailure;

export type DraftingProvider = 'gemini' | 'groq' | 'deepseek' | 'claude-bridge';

export interface ModelRotationSuccess {
  ok: true;
  subject: string;
  body: string;
  modelUsed: DraftingProvider;
}

export interface ModelRotationFailure {
  ok: false;
  /** Human-readable reason covering every provider attempted. */
  reason: string;
}

// Returned by model-rotation.ts after trying every configured
// provider/key combination for one generation.
export type ModelRotationResult = ModelRotationSuccess | ModelRotationFailure;

export interface HumanizeOutcomeSummary {
  attempted: boolean;
  outcome?: 'humanized' | 'deferred' | 'failed';
  reason?: string;
}

export interface DraftedResult {
  ok: true;
  drafts: Draft[];
  /** Humanizer pass outcome for the prospect's primary (variant 1) draft
   * only — see drafting.service.ts's doc comment for why only variant 1. */
  humanize: HumanizeOutcomeSummary;
}

export interface FlaggedResult {
  ok: false;
  flagged: 'missing_signal' | 'no_llm_available' | 'invalid_draft_output';
  message: string;
}

// `draftProspect`'s result once a prospect is confirmed to exist (`null`
// return still means "not found", same convention as enrichProspect).
export type DraftProspectOutcome = DraftedResult | FlaggedResult;

export interface HumanizeBatchItemResult {
  draftId: string;
  outcome: 'humanized' | 'stopped';
  reason?: string;
}

export interface HumanizeBatchSummary {
  attempted: number;
  results: HumanizeBatchItemResult[];
}
