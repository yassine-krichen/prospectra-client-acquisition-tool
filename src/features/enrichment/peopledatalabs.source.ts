import { z } from 'zod';

import { env } from '@/common/config/env';
import type { EnrichmentInput, EnrichmentResult } from '@/features/enrichment/enrichment.types';

const PERSON_ENRICH_URL = 'https://api.peopledatalabs.com/v5/person/enrich';

// PDL scores a match's confidence as a 1-10 "likelihood", not the 0-100
// scale this app's `emailConfidence` uses elsewhere (Hunter's own score is
// already 0-100). This threshold is PDL's own documented cutoff for a
// "high-confidence" match — below it, PDL considers the match itself
// uncertain, so `emailVerified` is only set `true` at or above it.
const HIGH_CONFIDENCE_LIKELIHOOD = 8;

// hunter.source.ts documents that this app's pattern-guess+MX-check
// fallback (emailConfidence 15) is meant to be the least confident non-empty
// result this app ever returns — Hunter's and PDL's own results are
// supposed to always score above it. PDL's 1-10 likelihood scaled by 10 can
// go as low as 10 (likelihood 1), which would violate that invariant, so a
// PDL match is only accepted at all once its scaled confidence clears the
// pattern-guess floor. A likelihood of 2 (confidence 20) is the lowest value
// that still holds a clear margin above it.
const MIN_ACCEPTABLE_LIKELIHOOD = 2;

// Minimal subset of the PDL Person Enrichment API response shape this
// source relies on. See https://docs.peopledatalabs.com/docs/enrichment-api
// for the full (much larger) shape.
const personEnrichResponseSchema = z.object({
  status: z.number(),
  likelihood: z.number().nullable().optional(),
  data: z
    .object({
      full_name: z.string().nullable().optional(),
      job_title: z.string().nullable().optional(),
      work_email: z.string().nullable().optional(),
      linkedin_url: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Looks up a contact's work email via People Data Labs' Person Enrichment
 * API, using the company domain (and contact name, if already known) as
 * match inputs. Returns a typed "unavailable" result — rather than
 * throwing — when PEOPLE_DATA_LABS_API_KEY is unset, PDL finds no confident
 * match, or the call fails.
 */
export async function runPeopleDataLabsEnrichment(input: EnrichmentInput): Promise<EnrichmentResult> {
  const apiKey = env.PEOPLE_DATA_LABS_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'source unavailable: PEOPLE_DATA_LABS_API_KEY not configured' };
  }

  const url = new URL(PERSON_ENRICH_URL);
  url.searchParams.set('company', input.domain);
  if (input.contactName) url.searchParams.set('name', input.contactName);

  let response: Response;
  try {
    response = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
  } catch (error) {
    return { ok: false, reason: `source unavailable: PDL request failed (${(error as Error).message})` };
  }

  // PDL returns 404 for "no match found", not an error condition worth
  // treating any differently from any other non-2xx here.
  if (!response.ok) {
    return { ok: false, reason: `source unavailable: PDL responded with ${response.status}` };
  }

  const parsed = personEnrichResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: PDL response did not match the expected shape' };
  }

  const workEmail = parsed.data.data?.work_email;
  if (!workEmail) {
    return { ok: false, reason: 'source unavailable: PDL found no work email for this contact' };
  }

  const likelihood = parsed.data.likelihood ?? 0;
  if (likelihood < MIN_ACCEPTABLE_LIKELIHOOD) {
    return {
      ok: false,
      reason: `source unavailable: PDL match likelihood (${likelihood}) is too low to trust`,
    };
  }

  return {
    ok: true,
    contact: {
      contactName: parsed.data.data?.full_name ?? input.contactName,
      contactTitle: parsed.data.data?.job_title ?? null,
      contactEmail: workEmail,
      emailVerified: likelihood >= HIGH_CONFIDENCE_LIKELIHOOD,
      // PDL's 1-10 likelihood scaled to this app's 0-100 confidence range.
      emailConfidence: Math.round(likelihood * 10),
      linkedinUrl: parsed.data.data?.linkedin_url ?? null,
    },
  };
}
