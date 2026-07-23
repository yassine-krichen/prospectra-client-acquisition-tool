import { BANNED_PHRASES, MAX_WORDS, MIN_WORDS } from '@/features/drafting/prompt-templates';
import { validateDraftOutput } from '@/features/drafting/validate-draft-output';
import type { Signal } from '@/features/prospects/prospect.types';

// Stage 4 follow-ups are a template bank with light variable interpolation,
// not LLM-generated free-form text — the spec explicitly allows this
// ("follow-ups can be template-based with light variable interpolation").
// `fenceUntrustedData`/`UNTRUSTED_DATA_WARNING` in prompt-templates.ts exist
// specifically to stop a model from following instructions hidden inside
// scraped prospect data; there is no model anywhere in this module, so that
// particular mitigation doesn't apply here — nothing in this file ever reads
// `signal.description`/`signal.evidence` as an instruction, it's only ever
// spliced as inert display text into a fixed sentence. The one thing that
// still carries over from the original drafting prompt is the *hard output
// contract* (`MIN_WORDS`/`MAX_WORDS`/`BANNED_PHRASES`), which every rendered
// template below is authored to satisfy and which `renderFollowupTemplate`
// re-validates after interpolation (via `validateDraftOutput`, the same
// post-generation safety net drafting.service.ts uses) — a very long or
// very short scraped `companyName`/signal snippet could otherwise push a
// rendered body outside the allowed range.

// Each touch number gets a distinct angle, per the spec's "not a bare 'just
// bumping this'" requirement:
//   - touch 2 (first follow-up): a different value-prop angle (speed/cost of
//     a lean direct build vs. the back-and-forth of a larger agency).
//   - touch 3 (second follow-up): deliberately shorter and more direct —
//     acknowledges the earlier notes and offers a fast, low-commitment next
//     step (a scoped estimate).
//   - touch 4 (third/final follow-up): the "no worries either way" close —
//     explicitly signals this is the last touch and leaves the door open
//     without any pressure tactic.
export type FollowupTouchNumber = 2 | 3 | 4;

export interface FollowupTemplateInput {
  companyName: string;
  /** The subject of the original (touch 1) send, if known — used to keep the
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
// spliced into a template — keeps the interpolated snippet's contribution to
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
  return input.originalSubject ? `Re: ${input.originalSubject}` : `Following up — ${input.companyName}`;
}

function buildTouch2Body(input: FollowupTemplateInput): string {
  const signalSnippet = truncateForEmail(input.signal.description);
  return `Following up on my earlier note about ${input.companyName} — figured I'd share a different angle in case the first one didn't land. The gap I flagged (${signalSnippet}) tends to compound: teams lose weeks to back-and-forth with agencies before a single line of code ships, when a small, direct build usually gets there faster and for less. If a faster path forward is even mildly interesting right now, I'm happy to sketch out what that could look like for ${input.companyName} specifically — no pressure if the timing's off.`;
}

function buildTouch3Body(input: FollowupTemplateInput): string {
  const signalSnippet = truncateForEmail(input.signal.description);
  return `Quick follow-up on ${input.companyName} — inboxes get noisy, so I'll keep this short. The issue I flagged earlier (${signalSnippet}) is the kind of thing that quietly costs conversions until someone fixes it, and it's usually a small, contained project rather than a full rebuild. If that's useful, I can put together a short scope and rough estimate this week — just reply and I'll send it over.`;
}

function buildTouch4Body(input: FollowupTemplateInput): string {
  return `Last note from me on this, promise. I've reached out a couple of times about ${input.companyName} and haven't heard back, which is a completely fine signal that it isn't a priority right now. If that changes down the line, the door stays open — just reply to this thread and I'll pick it back up from there. Either way, wishing ${input.companyName} well, and I won't follow up again after this one.`;
}

const TOUCH_BUILDERS: Record<FollowupTouchNumber, (input: FollowupTemplateInput) => string> = {
  2: buildTouch2Body,
  3: buildTouch3Body,
  4: buildTouch4Body,
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
 * had to meet — see this module's doc comment for why that's still the one
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
