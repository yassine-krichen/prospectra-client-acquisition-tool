export type DiscoveryTrack = 'khalid' | 'voreon';

export interface BuildDiscoveryPromptInput {
  // Which outreach channel the prospects are for. Omitted = the original
  // generic upscale/professional-services behavior.
  track?: DiscoveryTrack;
  category: string;
  geography: string;
  count: number;
  // Free-text soft preference about job size/type (e.g. "prefer quick wins
  // like landing page refreshes") - never a hard filter, since a strong
  // technical-debt signal on a bigger job is still worth reporting.
  preference?: string;
}

/**
 * Builds the full prompt sent to the headless `claude` agent (see
 * claude-cli.ts) for one discovery run. Kept as plain string interpolation
 * rather than a templating dependency - this is the only place the prompt is
 * assembled, so a dependency would buy nothing.
 */
export function buildDiscoveryPrompt({ category, geography, count, preference, track }: BuildDiscoveryPromptInput): string {
  const preferenceSection = preference
    ? `\n\n## Job-size preference (soft, not a hard filter)\n\n${preference} Still report any qualifying prospect regardless of job size or type - this is a preference for sorting/prioritization, never a reason to discard an otherwise-verified strong signal.`
    : '';

  const trackSection = track ? TRACK_SECTIONS[track] : '';

  return `You are doing cold-outreach prospecting for a solo developer/agency operator who sells web
and software development services. Your job is to find real, currently-operating businesses in
"${geography}" in the "${category}" category that are upscale/professional-services in nature (the
kind of business that has budget for web/dev work) and whose own public web presence reveals a
genuine technical-debt or opportunity signal - something a developer could credibly pitch fixing or
building.

## Allowed signal types

Every prospect you report MUST be tagged with exactly one of these signal types - pick only from
this set, do not invent a new one:

- outdated_site: the company's website looks visibly outdated (old design patterns, broken layout,
  unmaintained content, copyright year far in the past).
- no_https: the company's website is served over plain HTTP, with no valid TLS/HTTPS.
- old_stack: the site is built on a technology stack that is stale, unsupported, or unusually dated
  for a currently-operating business.
- new_launch: the company just launched a new product, site, or service (recent, verifiable news).
- funding_event: the company recently raised funding (a verifiable funding announcement).
- hiring_post: the company is actively hiring for a role that suggests it can't yet support its own
  technical needs internally.
- no_website: the company appears to have no website at all despite being an otherwise legitimate,
  operating business.
- technical_debt: general but concrete evidence of accumulated technical debt (e.g. an obviously
  unmaintained CMS, broken forms, dead integrations) not covered by the more specific types above.
- recently_registered: the business was recently registered/incorporated (a verifiable registration
  record or news mention).

## Mandatory fetch-then-assert method

1. Use WebSearch to find real candidate companies matching the category and geography above.
2. For each candidate, use WebFetch to fetch the candidate's actual website (or the specific page
   backing a claimed signal, e.g. a careers page for hiring_post or a news article for
   funding_event) and read the real fetched content.
3. Never assert a signal based only on a search result snippet, a summary, or anything from your own
   prior/training knowledge. A signal must be something you directly observed in content you
   actually fetched during this session.
4. If you cannot directly verify a claim by fetching real content, discard that candidate entirely
   rather than guessing or reporting it with lower confidence. Do not include unverified candidates.

## Corroboration

Where feasible, try to verify and record a second, independent signal for a candidate (for example: a
job posting confirming a hiring_post claim, or a funding news article confirming a funding_event
claim) in the \`secondarySignal\` field. If you cannot find and verify a genuine second signal, set
\`secondarySignal\` to \`null\` - never fabricate one just to fill the field.

## Output contract

Output ONLY JSONL - one JSON object per line, no markdown code fences, no prose before or after, no
trailing commentary. Each line must be a single JSON object with exactly these keys:

{
  "companyName": string,
  "domain": string | null,
  "websiteUrl": string (valid URL) | null,
  "industry": one of "local_service" | "saas" | "ecommerce" | "agency" | "other",
  "companySize": one of "1-10" | "11-50" | "51-200" | "201+" | "unknown",
  "city": string | null,
  "country": string | null,
  "phone": string | null,
  "address": string | null,
  "signalType": one of "outdated_site" | "no_https" | "old_stack" | "new_launch" | "funding_event" | "hiring_post" | "no_website" | "technical_debt" | "recently_registered",
  "signalStrength": one of "weak" | "medium" | "strong",
  "signalDescription": string (one or two sentences describing the specific signal you observed),
  "evidenceUrl": string (valid URL - the exact page you fetched that proves the signal),
  "evidenceSummary": string (what you actually saw in the fetched content that supports the signal),
  "secondarySignal": string | null,
  "contactName": string | null,
  "contactRole": string | null,
  "contactEmail": string (valid email) | null,
  "emailSource": "published" | "guessed" | "none",
  "contactPageUrl": string (valid URL of the contact page/form) | null,
  "pitchAngle": string | null
}

Contact fields: contactEmail/contactName/contactRole are only ever taken from pages you fetched.
emailSource is "published" if the exact address appears in fetched content, "guessed" ONLY if you
inferred it from a pattern you saw published for the same domain (e.g. first@domain seen for another
staff member), and "none" with contactEmail null if you found nothing. Never invent an address, and
never output generic info@/contact@ as "guessed". Do NOT drop a prospect just because no email was
found - report it with emailSource "none" and set contactPageUrl (and phone) so the operator can
follow up by hand.

## Target count

Find up to ${count} qualifying companies. Fewer verified real prospects is better than more
unverified ones. Do not pad the list with unverified or low-confidence candidates.${trackSection}${preferenceSection}`;
}

const TRACK_SECTIONS: Record<DiscoveryTrack, string> = {
  khalid: `

## Track: local walk-in / phone outreach

These prospects go to a partner who visits or phones small local businesses in person. Target
small (1-10 staff), owner-operated local trades and service businesses - roofing, general
contractors, remodeling, auto repair, event venues, specialty distributors, boutique shops, similar.
Overrides the "upscale/professional-services" wording above: small and local is the goal here.
Phone number AND street address are REQUIRED for every prospect (discard candidates without both).
Favor signals no_website, outdated_site, no_https, old_stack. pitchAngle: one sentence on what to
offer (e.g. "no site at all: simple 1-page site + Google listing link"). Contact email is optional.`,
  voreon: `

## Track: cold email, web/software studio

These prospects get cold emails from a small web/software studio (landing pages, marketing sites,
booking/CRM tools, custom apps). Two acceptable tiers, tag each in pitchAngle starting with
"[LANDING]" or "[BIGGER]":
- [LANDING]: very small businesses (1-10 staff) whose site is missing, broken, or dated - quick,
  low-priced landing-page wins.
- [BIGGER]: established SMBs (11-200 staff) with budget - dated site, missing booking/portal, a
  hiring post or launch implying a build need.
Reach the actual decision-maker: owner/founder for under ~50 staff; operations, marketing or
managing partner for larger ones. Find contactName/contactRole/contactEmail by fetching the
about/team/contact pages. Prefer prospects where a real named person AND a published email are found.
Real US businesses only (the studio is outside the US; a US presence is required to be a fit).
pitchAngle: one sentence naming the concrete observed problem and the concrete offer.`,
};
