import { z } from 'zod';

import { env } from '@/common/config/env';
import { buildRegistrySignal } from '@/features/discovery/sources/registry-signal';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';

const FRANCHISE_TAX_LIST_URL = 'https://api.comptroller.texas.gov/public-data/v1/public/franchise-tax-list';
const FRANCHISE_TAX_DETAIL_URL = 'https://api.comptroller.texas.gov/public-data/v1/public/franchise-tax';

// Caps the fan-out of per-entity detail lookups against the search result -
// keeps a broad category search from firing dozens of parallel requests.
const MAX_DETAIL_LOOKUPS = 20;

const searchResultSchema = z.object({
  taxpayerId: z.string(),
  name: z.string(),
  fileNumber: z.string().nullable().optional(),
});

const searchResponseSchema = z.object({
  success: z.boolean(),
  count: z.number(),
  data: z.array(searchResultSchema).default([]),
});

// Detail lookups have the same "expected data sparsity, not a parsing bug"
// posture as overpass.source.ts's `buildAddress` - only `name` is guaranteed.
const detailResponseSchema = z.object({
  name: z.string(),
  dbaName: z.string().nullable().optional(),
  mailingAddressStreet: z.string().nullable().optional(),
  mailingAddressCity: z.string().nullable().optional(),
  mailingAddressState: z.string().nullable().optional(),
  mailingAddressZip: z.string().nullable().optional(),
  sosRegistrationStatus: z.string().nullable().optional(),
  effectiveSosRegistrationDate: z.string().nullable().optional(),
  stateOfFormation: z.string().nullable().optional(),
  registeredAgentName: z.string().nullable().optional(),
  sosFileNumber: z.string().nullable().optional(),
});
type FranchiseTaxDetail = z.infer<typeof detailResponseSchema>;

/**
 * Fetches franchise tax detail for a single taxpayer id. Returns `null` on
 * any fetch error or schema mismatch instead of throwing - a single bad
 * lookup shouldn't fail the whole `Promise.all` fan-out (see `buildAddress`
 * in overpass.source.ts for the same "sparse data is expected" posture).
 */
async function fetchDetail(taxpayerId: string, apiKey: string): Promise<FranchiseTaxDetail | null> {
  try {
    const response = await fetch(`${FRANCHISE_TAX_DETAIL_URL}/${taxpayerId}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!response.ok) return null;

    const parsed = detailResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Deliberately drops entries with a missing `sosRegistrationStatus`, unlike
// companies-house.source.ts's `isActiveOrUnknownStatus`, which keeps them.
// This is an intentional divergence, not an oversight: in this source's
// data, a missing SOS status correlates with defunct/duplicate franchise-tax
// filings, whereas Companies House returning no status is just incomplete
// data on an otherwise-real listing. See this function's test for the
// behavior this comment documents.
function isActiveRegistration(detail: FranchiseTaxDetail): boolean {
  return detail.sosRegistrationStatus?.toLowerCase() === 'active';
}

// Strips punctuation ("Austin, TX" -> "austin tx") before comparing - unlike
// companies-house.source.ts's `matchesGeography`, which checks a single
// free-text address string against `geography` as-is, this source builds
// `cityAndState` itself by joining two separate fields with a plain space,
// so a comma-containing `geography` value (the format the discovery form
// actually produces, e.g. "Austin, TX") would otherwise never match.
function normalizeForGeographyMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesGeography(detail: FranchiseTaxDetail, geography: string): boolean {
  const cityAndState = [detail.mailingAddressCity, detail.mailingAddressState].filter(Boolean).join(' ');
  // Neither field is present - geography can't be checked either way, so
  // this entry is kept rather than dropped (same posture as
  // companies-house.source.ts's `matchesGeography`).
  if (!cityAndState) return true;
  return normalizeForGeographyMatch(cityAndState).includes(normalizeForGeographyMatch(geography));
}

// Same join-and-filter-falsy pattern as overpass.source.ts's `buildAddress`.
function buildAddress(detail: FranchiseTaxDetail): string | null {
  const street = detail.mailingAddressStreet;
  const cityStateZip = [detail.mailingAddressCity, detail.mailingAddressState, detail.mailingAddressZip]
    .filter(Boolean)
    .join(' ');
  const address = [street, cityStateZip].filter(Boolean).join(', ');
  return address || null;
}

function mapToProspect(detail: FranchiseTaxDetail, query: DiscoveryQuery, searchUrl: string): DiscoveredProspect {
  return {
    companyName: detail.dbaName ?? detail.name,
    domain: null,
    websiteUrl: null,
    industry: 'other',
    location: { city: query.geography, country: 'United States', lat: null, lng: null },
    companySize: 'unknown',
    source: 'texas_comptroller',
    // No public detail-page URL is confirmed available for an individual
    // franchise tax record - `DiscoveredProspect.sourceUrl` is non-nullable
    // (mirrors `Prospect.sourceUrl String` in prisma/schema.prisma), so this
    // falls back to the search query URL itself, same pattern
    // yellowpages.source.ts already uses for a source with no per-listing URL.
    sourceUrl: searchUrl,
    discoveredAt: new Date(),
    phone: null,
    address: buildAddress(detail),
    corroboratingSourceCount: 1,
    signal: buildRegistrySignal(detail.effectiveSosRegistrationDate ?? null, 'Texas Comptroller'),
  };
}

/**
 * Searches the Texas Comptroller's franchise tax list for taxpayers matching
 * `query.category`, then fetches per-taxpayer detail for up to
 * `MAX_DETAIL_LOOKUPS` results, filters to active SOS registrations whose
 * mailing address loosely matches `query.geography`, and maps the result to
 * prospects. Returns a typed "unavailable" result - rather than throwing -
 * when TEXAS_COMPTROLLER_API_KEY is unset or the search call fails; a single
 * failed detail lookup is skipped rather than failing the whole source (see
 * `fetchDetail`).
 */
export async function runTexasComptrollerSource(query: DiscoveryQuery): Promise<SourceResult> {
  const apiKey = env.TEXAS_COMPTROLLER_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'source unavailable: TEXAS_COMPTROLLER_API_KEY not configured' };
  }

  const searchUrl = `${FRANCHISE_TAX_LIST_URL}?name=${encodeURIComponent(query.category)}`;

  let searchResponse: Response;
  try {
    searchResponse = await fetch(searchUrl, { headers: { 'x-api-key': apiKey } });
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: Texas Comptroller search request failed (${(error as Error).message})`,
    };
  }

  if (!searchResponse.ok) {
    return { ok: false, reason: `source unavailable: Texas Comptroller responded with ${searchResponse.status}` };
  }

  const parsedSearch = searchResponseSchema.safeParse(await searchResponse.json().catch(() => null));
  if (!parsedSearch.success) {
    return { ok: false, reason: 'source unavailable: Texas Comptroller search response did not match the expected shape' };
  }

  const capped = parsedSearch.data.data.slice(0, MAX_DETAIL_LOOKUPS);
  const details = await Promise.all(capped.map((entry) => fetchDetail(entry.taxpayerId, apiKey)));

  const prospects = details
    .filter((detail): detail is FranchiseTaxDetail => detail !== null)
    .filter(isActiveRegistration)
    .filter((detail) => matchesGeography(detail, query.geography))
    .map((detail) => mapToProspect(detail, query, searchUrl));

  return { ok: true, prospects };
}
