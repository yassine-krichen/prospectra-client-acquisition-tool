import { BANNED_PHRASES, MAX_WORDS, MIN_WORDS } from '@/features/drafting/prompt-templates';
import { validateDraftOutput } from '@/features/drafting/validate-draft-output';
import type { Signal } from '@/features/prospects/prospect.types';

// Stage 4 follow-ups are a template bank with light variable interpolation,
// not LLM-generated free-form text - the spec explicitly allows this
// ("follow-ups can be template-based with light variable interpolation").
// `fenceUntrustedData`/`UNTRUSTED_DATA_WARNING` in prompt-templates.ts exist
// specifically to stop a model from following instructions hidden inside
// scraped prospect data; there is no model anywhere in this module, so that
// particular mitigation doesn't apply here - nothing in this file ever reads
// `signal.description`/`signal.evidence` as an instruction, it's only ever
// spliced as inert display text into a fixed sentence. The one thing that
// still carries over from the original drafting prompt is the *hard output
// contract* (`MIN_WORDS`/`MAX_WORDS`/`BANNED_PHRASES`), which every rendered
// template below is authored to satisfy and which `renderFollowupTemplate`
// re-validates after interpolation (via `validateDraftOutput`, the same
// post-generation safety net drafting.service.ts uses) - a very long or
// very short scraped `companyName`/signal snippet could otherwise push a
// rendered body outside the allowed range.

// Cold-outreach data supports one follow-up only (see MAX_TOTAL_TOUCHES in
// followup-scheduler.ts), so there is a single template: a different
// value-prop angle from the original (speed/cost of a lean direct build vs.
// the back-and-forth of a larger agency), not a bare "just bumping this".
export type FollowupTouchNumber = 2;

export interface FollowupTemplateInput {
  companyName: string;
  /** The subject of the original (touch 1) send, if known - used to keep the
   * follow-up in the same email thread via a "Re: " prefix. `null` when no
   * original draft/subject is on file, e.g. a prospect sent outside this
   * app's normal drafting flow. */
  originalSubject: string | null;
  signal: Signal;
}

export interface FollowupTemplateOutput {
  subject: string;
  body: string;
}

// Bounds how much of a scraped, arbitrary-length `signal.description` gets
// spliced into a template - keeps the interpolated snippet's contribution to
// the rendered body's word count predictable, rather than letting one
// unusually long scraped description alone push the body outside
// `[MIN_WORDS, MAX_WORDS]`. `validateDraftOutput` below is still the actual
// enforcement point; this is just to make violations rare rather than
// routine.
const MAX_SIGNAL_SNIPPET_CHARS = 140;

function truncateForEmail(text: string, maxChars: number = MAX_SIGNAL_SNIPPET_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function buildSubject(input: FollowupTemplateInput): string {
  return input.originalSubject ? `Re: ${input.originalSubject}` : `Following up - ${input.companyName}`;
}

function buildTouch2Body(input: FollowupTemplateInput): string {
  const signalSnippet = truncateForEmail(input.signal.description);
  return `Bumping my note about ${input.companyName}, in case it got buried. The gap I flagged (${signalSnippet}) is usually a small, contained fix rather than a full rebuild. If it's useful, I can send a short scope and rough estimate this week - just reply and I'll put it together. No worries if the timing's off.`;
}

const TOUCH_BUILDERS: Record<FollowupTouchNumber, (input: FollowupTemplateInput) => string> = {
  2: buildTouch2Body,
};

export interface FollowupTemplateRenderSuccess {
  ok: true;
  template: FollowupTemplateOutput;
}

export interface FollowupTemplateRenderFailure {
  ok: false;
  /** Which hard constraint the rendered body violated, e.g. word count. */
  reasons: string[];
}

export type FollowupTemplateRenderResult = FollowupTemplateRenderSuccess | FollowupTemplateRenderFailure;

/**
 * Renders the follow-up template for `touchNumber`, then re-validates the
 * interpolated result against the same hard constraints
 * (`MIN_WORDS`/`MAX_WORDS`/`BANNED_PHRASES`) the original LLM-drafted email
 * had to meet - see this module's doc comment for why that's still the one
 * carried-over safety net even though no model is involved. Returns
 * `ok:false` (never throws, never sends a non-compliant body) if
 * interpolation happened to push the result outside those bounds.
 */
export function renderFollowupTemplate(
  touchNumber: FollowupTouchNumber,
  input: FollowupTemplateInput
): FollowupTemplateRenderResult {
  const body = TOUCH_BUILDERS[touchNumber](input);
  const subject = buildSubject(input);

  const validation = validateDraftOutput({ subject, body });
  if (!validation.valid) {
    return { ok: false, reasons: validation.reasons };
  }

  return { ok: true, template: { subject, body } };
}

// Re-exported for callers (e.g. tests) that want to double-check bounds
// without importing prompt-templates.ts directly.
export { BANNED_PHRASES, MAX_WORDS, MIN_WORDS };
