import { z } from 'zod';

import { env } from '@/common/config/env';
import { buildNoSignalDetectedFallback, detectWebsiteSignals } from '@/features/discovery/signal-detection';
import { extractDomain } from '@/features/discovery/normalize-domain';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';
import type { Signal } from '@/features/prospects/prospect.types';

const TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

// Google Places has no first-class "recently opened" filter. This threshold
// approximates that warm-lead signal via a low review count on an
// operational listing - the real intent ("recently opened, likely no
// investment in a website yet") isn't what this actually checks. A
// well-established but rarely-reviewed business would also match; treat it
// as a weak heuristic, not a direct signal.
const LOW_REVIEW_COUNT_THRESHOLD = 10;

const textSearchResultSchema = z.object({
  place_id: z.string(),
  name: z.string(),
  business_status: z.string().optional(),
  user_ratings_total: z.number().optional(),
  geometry: z
    .object({ location: z.object({ lat: z.number(), lng: z.number() }).optional() })
    .optional(),
});

const textSearchResponseSchema = z.object({
  status: z.string(),
  results: z.array(textSearchResultSchema).default([]),
  error_message: z.string().optional(),
});

const placeDetailsResponseSchema = z.object({
  status: z.string(),
  result: z.object({ website: z.string().optional() }).optional(),
});

async function fetchPlaceWebsite(placeId: string, apiKey: string): Promise<string | null> {
  const url = new URL(PLACE_DETAILS_URL);
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'website');
  url.searchParams.set('key', apiKey);

  const response = await fetch(url).catch(() => null);
  if (!response || !response.ok) return null;

  const parsed = placeDetailsResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.status !== 'OK') return null;

  return parsed.data.result?.website ?? null;
}

async function buildSignal(
  websiteUrl: string | null,
  userRatingsTotal: number | undefined,
  businessStatus: string | undefined
): Promise<Signal> {
  if (!websiteUrl) {
    return {
      type: 'no_website',
      description: 'No website listed on the Google Business Profile',
      evidence: null,
      strength: 'strong',
    };
  }

  const detected = await detectWebsiteSignals(websiteUrl);
  if (detected) return detected;

  const looksRecentlyOpened =
    businessStatus === 'OPERATIONAL' && (userRatingsTotal ?? 0) < LOW_REVIEW_COUNT_THRESHOLD;
  if (looksRecentlyOpened) {
    return {
      type: 'new_launch',
      description: 'Approximated "recently opened" via a low Google review count on an operational listing',
      evidence: `${userRatingsTotal ?? 0} reviews`,
      strength: 'weak',
    };
  }

  return buildNoSignalDetectedFallback(null);
}

/**
 * Searches Google Places Text Search by category + geography, then fetches
 * Place Details (website) for each result. Returns a typed "unavailable"
 * result - rather than throwing - when GOOGLE_PLACES_API_KEY is unset or
 * the API call fails, so one missing key doesn't crash discovery.
 */
export async function runGooglePlacesSource(query: DiscoveryQuery): Promise<SourceResult> {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'source unavailable: GOOGLE_PLACES_API_KEY not configured' };
  }

  const url = new URL(TEXT_SEARCH_URL);
  url.searchParams.set('query', `${query.category} in ${query.geography}`);
  url.searchParams.set('key', apiKey);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: Google Places request failed (${(error as Error).message})`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `source unavailable: Google Places responded with ${response.status}` };
  }

  const parsed = textSearchResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: Google Places response did not match the expected shape' };
  }

  if (parsed.data.status !== 'OK' && parsed.data.status !== 'ZERO_RESULTS') {
    const detail = parsed.data.error_message ? ` (${parsed.data.error_message})` : '';
    return { ok: false, reason: `source unavailable: Google Places returned status ${parsed.data.status}${detail}` };
  }

  const prospects: DiscoveredProspect[] = [];
  for (const result of parsed.data.results) {
    const websiteUrl = await fetchPlaceWebsite(result.place_id, apiKey);
    const signal = await buildSignal(websiteUrl, result.user_ratings_total, result.business_status);

    prospects.push({
      companyName: result.name,
      domain: extractDomain(websiteUrl),
      websiteUrl,
      // Google Places Text Search doesn't return a structured industry
      // category we can map to our enum reliably; Branch A's Google Places
      // source is scoped to local/SMB discovery, so default accordingly.
      industry: 'local_service',
      location: {
        city: query.geography,
        country: null,
        lat: result.geometry?.location?.lat ?? null,
        lng: result.geometry?.location?.lng ?? null,
      },
      companySize: 'unknown',
      source: 'google_places',
      sourceUrl: `https://www.google.com/maps/place/?q=place_id:${result.place_id}`,
      discoveredAt: new Date(),
      phone: null,
      address: null,
      corroboratingSourceCount: 1,
      signal,
    });
  }

  return { ok: true, prospects };
}
