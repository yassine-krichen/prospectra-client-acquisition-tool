import { BANNED_PHRASES, MAX_WORDS, MIN_WORDS } from '@/features/drafting/prompt-templates';
import { validateDraftOutput } from '@/features/drafting/validate-draft-output';

// Phase 8 post-sale retention touches are, like Stage 4 follow-ups, a
// template bank with light variable interpolation - not LLM-generated
// free-form text. There is no model anywhere in this module. The one thing
// still carried over from the drafting prompt is the hard output contract
// (`MIN_WORDS`/`MAX_WORDS`/`BANNED_PHRASES`), which every rendered template
// below is authored to satisfy and which `renderRetentionTemplate`
// re-validates after interpolation (via `validateDraftOutput`) - an
// interpolated `companyName` sourced from a converted Prospect could in
// principle be unusually long and push a rendered body outside the allowed
// range, same rationale as followup-templates.ts.

// Four named "kinds" of touch, not a flat sequential count - retention
// touches repeat indefinitely (day 90, 180, 270…) once a Job reaches the
// quarterly stage, so a `FollowupTouchNumber`-style fixed union stays small
// and meaningful by naming the KIND of touch rather than trying to enumerate
// every future occurrence. `retention-scheduler.ts` owns the day-offset
// schedule (mirroring how `FOLLOWUP_INTERVAL_DAYS` lives in
// followup-scheduler.ts, not followup-templates.ts) and maps a Job's
// `cadence`/`retentionTouchCount` onto one of these four kinds:
//   - 1 (review):     one-off only, day 3 after delivery - ask for a
//                      review/testimonial while the work is freshest in mind.
//   - 2 (referral):    one-off only, day 14 - ask for a referral.
//   - 3 (checkin_30):  one-off only, day 30 - a genuine check-in, with an
//                       upsell mention unless a monthly retainer already
//                       exists on this Client (see `RetentionVariant`).
//   - 4 (quarterly):   one-off Jobs from day 90 onward (repeating every 90
//                       days indefinitely), AND every touch on a recurring
//                       (`monthly`) Job starting at day 90 from `soldAt` (a
//                       retainer never "delivers" in the terminal sense the
//                       first three touches assume, so it only ever gets
//                       this one recurring check-in/upsell cadence).
export type RetentionTouchNumber = 1 | 2 | 3 | 4;

// Day-30-or-later touches (`checkin_30`/`quarterly`) suppress the upsell ask
// when a sibling `monthly` Job already exists on the same Client - no point
// pitching a retainer someone already bought. Day-3/day-14 touches
// (review/referral) never carry an upsell at all, so this variant is simply
// unused for those two kinds.
export type RetentionVariant = 'with_upsell' | 'checkin_only';

export interface RetentionTemplateInput {
  companyName: string;
  /** Ignored for touch 1 (review) and touch 2 (referral) - those never
   * upsell. Required in practice for touch 3/4, where the scheduler has
   * already resolved whether a sibling `monthly` Job exists on this Client. */
  variant: RetentionVariant;
}

export interface RetentionTemplateOutput {
  subject: string;
  body: string;
}

function buildTouch1Subject(input: RetentionTemplateInput): string {
  return `A quick favor for ${input.companyName}`;
}

function buildTouch1Body(input: RetentionTemplateInput): string {
  return `Hi, it's been a few days since wrapping up the work for ${input.companyName}, and I wanted to check how everything's settling in. If it's going well, a short review or testimonial would help a lot - even two or three sentences about what changed for ${input.companyName} makes a real difference for other business owners deciding whether to work with me. No pressure at all, just a genuine ask if you have five minutes to spare this week. Either way, it was a pleasure getting ${input.companyName} set up, and I hope it keeps paying off.`;
}

function buildTouch2Subject(input: RetentionTemplateInput): string {
  return `Know someone who could use this, ${input.companyName}?`;
}

function buildTouch2Body(input: RetentionTemplateInput): string {
  return `Two weeks in now, and I hope things are still running smoothly for ${input.companyName}. If you know another business owner who could use similar help - a site refresh, a new build, or anything in that vein - I'd genuinely appreciate the introduction. Referrals from clients like ${input.companyName} are how most of this work comes together, and I always take good care of anyone sent my way. No pressure if nothing comes to mind right now, just wanted to plant the seed while the work's still fresh for you.`;
}

function buildCheckin30Subject(): string {
  return 'Checking in one month in';
}

function buildCheckin30Body(input: RetentionTemplateInput): string {
  if (input.variant === 'with_upsell') {
    return `A month out from launch now, and I wanted to check in on how ${input.companyName} is doing with everything. If small tweaks or new ideas have come up since things went live, I'm happy to help - and if a recurring plan for ongoing updates, hosting, or maintenance would take something off your plate, that's worth a quick conversation too. No obligation either way, just flagging the option in case it's useful for ${input.companyName} going forward. Let me know how things are going whenever you get a chance.`;
  }

  return `A month out from launch now, and I wanted to check in on how ${input.companyName} is doing with everything. If small tweaks or questions have come up since things went live, I'm happy to help however I can. No obligation at all, just wanted to make sure ${input.companyName} is fully settled in and everything's working the way it should. Let me know how things are going whenever you get a chance, and thanks again for the opportunity to work together.`;
}

function buildQuarterlySubject(): string {
  return 'Quarterly check-in';
}

function buildQuarterlyBody(input: RetentionTemplateInput): string {
  if (input.variant === 'with_upsell') {
    return `Checking in on ${input.companyName} again this quarter - it's been a while since the last update, and I wanted to see how things are holding up. If a recurring plan for ongoing updates, hosting, or maintenance would help take something off your plate, I'd be glad to walk through what that could look like for ${input.companyName}. No pressure either way, just wanted to keep the door open in case it's useful right now. Hope things are going well on your end, and thanks again for continuing to work together.`;
  }

  return `Checking in on ${input.companyName} again this quarter - it's been a while since the last update, and I wanted to see how things are holding up. If anything needs attention or you have questions about the site, I'm happy to help whenever it's convenient. No obligation at all, just wanted to make sure everything's still running smoothly for ${input.companyName}. Hope things are going well on your end, and thanks again for continuing to work together.`;
}

const TOUCH_BUILDERS: Record<
  RetentionTouchNumber,
  { subject: (input: RetentionTemplateInput) => string; body: (input: RetentionTemplateInput) => string }
> = {
  1: { subject: buildTouch1Subject, body: buildTouch1Body },
  2: { subject: buildTouch2Subject, body: buildTouch2Body },
  3: { subject: buildCheckin30Subject, body: buildCheckin30Body },
  4: { subject: buildQuarterlySubject, body: buildQuarterlyBody },
};

export interface RetentionTemplateRenderSuccess {
  ok: true;
  template: RetentionTemplateOutput;
}

export interface RetentionTemplateRenderFailure {
  ok: false;
  reasons: string[];
}

export type RetentionTemplateRenderResult = RetentionTemplateRenderSuccess | RetentionTemplateRenderFailure;

/**
 * Renders the retention template for `touchNumber`, then re-validates the
 * interpolated result against the same hard constraints
 * (`MIN_WORDS`/`MAX_WORDS`/`BANNED_PHRASES`) drafted emails and follow-ups
 * are held to - see this module's doc comment for why. Returns `ok:false`
 * (never throws, never sends a non-compliant body) if interpolating
 * `companyName` happened to push the result outside those bounds.
 */
export function renderRetentionTemplate(
  touchNumber: RetentionTouchNumber,
  input: RetentionTemplateInput
): RetentionTemplateRenderResult {
  const builder = TOUCH_BUILDERS[touchNumber];
  const subject = builder.subject(input);
  const body = builder.body(input);

  const validation = validateDraftOutput({ subject, body });
  if (!validation.valid) {
    return { ok: false, reasons: validation.reasons };
  }

  return { ok: true, template: { subject, body } };
}

// Re-exported for callers (e.g. tests) that want to double-check bounds
// without importing prompt-templates.ts directly.
export { BANNED_PHRASES, MAX_WORDS, MIN_WORDS };
