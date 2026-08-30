import { z } from 'zod';

import { env } from '@/common/config/env';
import { buildRegistrySignal } from '@/features/discovery/sources/registry-signal';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';

const COMPANIES_HOUSE_SEARCH_URL = 'https://api.company-information.service.gov.uk/search/companies';

// Companies House's public data is deliberately sparse on some fields (a
// company can be returned with just a name and number and nothing else) -
// same posture as overpass.source.ts's `buildAddress` comment: expected data
// sparsity, not a parsing bug, so every field beyond title/company_number is
// optional/nullable.
//
// The *search* endpoint's items use `title` for the display name, not
// `company_name` - confirmed live 2026-08-30 against a real API response.
// `company_name` is the field Companies House's separate company-profile
// endpoint (GET /company/{number}) uses, not this one; using that name here
// was wrong and made every single search result fail validation, degrading
// the whole source to "unavailable" on every real call.
const companyItemSchema = z.object({
  title: z.string(),
  company_number: z.string(),
  address_snippet: z.string().nullable().optional(),
  date_of_creation: z.string().nullable().optional(),
  company_status: z.string().nullable().optional(),
  company_type: z.string().nullable().optional(),
});

const companiesHouseResponseSchema = z.object({
  items: z.array(companyItemSchema).default([]),
});

function matchesGeography(item: z.infer<typeof companyItemSchema>, geography: string): boolean {
  // A missing address can't be checked against `geography` at all - kept
  // rather than dropped, since geography can't be confirmed either way (see
  // this function's callers).
  if (!item.address_snippet) return true;
  return item.address_snippet.toLowerCase().includes(geography.toLowerCase());
}

function isActiveOrUnknownStatus(item: z.infer<typeof companyItemSchema>): boolean {
  // A dissolved/liquidated company isn't an outreach target - but an absent
  // status can't be confirmed either way, so it's kept rather than dropped.
  if (!item.company_status) return true;
  return item.company_status.toLowerCase() === 'active';
}

function mapToProspect(item: z.infer<typeof companyItemSchema>, query: DiscoveryQuery): DiscoveredProspect {
  return {
    companyName: item.title,
    domain: null,
    websiteUrl: null,
    industry: 'other',
    location: { city: query.geography, country: 'United Kingdom', lat: null, lng: null },
    companySize: 'unknown',
    source: 'companies_house',
    sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${item.company_number}`,
    discoveredAt: new Date(),
    phone: null,
    address: item.address_snippet ?? null,
    corroboratingSourceCount: 1,
    signal: buildRegistrySignal(item.date_of_creation ?? null, 'UK Companies House'),
  };
}

/**
 * Searches UK Companies House's public company search API for companies
 * matching `query.category`, filtered to active (or unknown-status)
 * companies whose address loosely matches `query.geography`. Returns a
 * typed "unavailable" result - rather than throwing - when
 * COMPANIES_HOUSE_API_KEY is unset or the API call fails, so a missing key
 * or a down API doesn't crash discovery.
 */
export async function runCompaniesHouseSource(query: DiscoveryQuery): Promise<SourceResult> {
  const apiKey = env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'source unavailable: COMPANIES_HOUSE_API_KEY not configured' };
  }

  const url = `${COMPANIES_HOUSE_SEARCH_URL}?q=${encodeURIComponent(query.category)}`;
  const authorization = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: authorization } });
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: Companies House request failed (${(error as Error).message})`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `source unavailable: Companies House responded with ${response.status}` };
  }

  const parsed = companiesHouseResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: Companies House response did not match the expected shape' };
  }

  const prospects = parsed.data.items
    .filter(isActiveOrUnknownStatus)
    .filter((item) => matchesGeography(item, query.geography))
    .map((item) => mapToProspect(item, query));

  return { ok: true, prospects };
}
