import { z } from 'zod';

import { env } from '@/common/config/env';
import { extractDomain } from '@/features/discovery/normalize-domain';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';

const FUNDING_ROUNDS_SEARCH_URL = 'https://api.crunchbase.com/api/v4/searches/funding_rounds';
const ORGANIZATION_ENTITY_URL = 'https://api.crunchbase.com/api/v4/entities/organizations';

// Recently funded = a signal an investment just happened, so the search
// window is intentionally narrow (freshly announced rounds only).
const LOOKBACK_DAYS = 90;
const ROUNDS_PER_QUERY = 20;

// Minimal subset of the Crunchbase v4 Search API's funding_rounds response
// shape this source relies on. See
// https://data.crunchbase.com/docs/using-the-api for the full shape.
const fundingRoundEntitySchema = z.object({
  uuid: z.string(),
  properties: z.object({
    announced_on: z.string().optional(),
    money_raised: z
      .object({ value_usd: z.number().optional(), currency: z.string().optional() })
      .nullable()
      .optional(),
    investment_type: z.string().optional(),
    funded_organization_identifier: z
      .object({ value: z.string().optional(), permalink: z.string().optional() })
      .nullable()
      .optional(),
  }),
});

const fundingRoundsResponseSchema = z.object({
  count: z.number().optional(),
  entities: z.array(fundingRoundEntitySchema).default([]),
});

const organizationEntitySchema = z.object({
  properties: z.object({
    website: z.object({ value: z.string().optional() }).nullable().optional(),
  }),
});

async function fetchOrganizationWebsite(permalink: string, apiKey: string): Promise<string | null> {
  const url = new URL(`${ORGANIZATION_ENTITY_URL}/${permalink}`);
  url.searchParams.set('field_ids', 'website');
  url.searchParams.set('user_key', apiKey);

  const response = await fetch(url).catch(() => null);
  if (!response || !response.ok) return null;

  const parsed = organizationEntitySchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;

  return parsed.data.properties.website?.value ?? null;
}

function formatFundingEvidence(
  amountUsd: number | undefined,
  investmentType: string | undefined,
  announcedOn: string | undefined
): string {
  const parts: string[] = [];
  if (amountUsd) parts.push(`$${amountUsd.toLocaleString('en-US')}`);
  if (investmentType) parts.push(investmentType);
  if (announcedOn) parts.push(`announced ${announcedOn}`);
  return parts.join(' ') || 'Funding round announced';
}

/**
 * Searches Crunchbase's v4 Search API for funding rounds announced within
 * the last `LOOKBACK_DAYS`, then fetches each funded organization's website.
 * `query.category` is used as a loose keyword filter on the funded
 * organization's name — Crunchbase's category taxonomy requires resolving
 * category UUIDs via a separate lookup this source doesn't perform, so this
 * is an approximation, not a true category-taxonomy filter (same caveat as
 * Google Places' "recently opened" heuristic in google-places.source.ts).
 * `query.geography` isn't applied as a location filter for the same reason
 * (Crunchbase location filters are also UUID-based); it's only used as a
 * location fallback on the resulting prospects.
 * Returns a typed "unavailable" result — rather than throwing — when
 * CRUNCHBASE_API_KEY is unset or the API call fails.
 */
export async function runCrunchbaseSource(query: DiscoveryQuery): Promise<SourceResult> {
  const apiKey = env.CRUNCHBASE_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'source unavailable: CRUNCHBASE_API_KEY not configured' };
  }

  const announcedAfter = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const url = new URL(FUNDING_ROUNDS_SEARCH_URL);
  url.searchParams.set('user_key', apiKey);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field_ids: ['announced_on', 'money_raised', 'investment_type', 'funded_organization_identifier'],
        query: [
          { type: 'predicate', field_id: 'announced_on', operator_id: 'gte', values: [announcedAfter] },
          { type: 'predicate', field_id: 'funded_organization_name', operator_id: 'contains', values: [query.category] },
        ],
        order: [{ field_id: 'announced_on', sort: 'desc' }],
        limit: ROUNDS_PER_QUERY,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: Crunchbase request failed (${(error as Error).message})`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `source unavailable: Crunchbase responded with ${response.status}` };
  }

  const parsed = fundingRoundsResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: Crunchbase response did not match the expected shape' };
  }

  const prospects: DiscoveredProspect[] = [];
  for (const entity of parsed.data.entities) {
    const org = entity.properties.funded_organization_identifier;
    if (!org?.value || !org.permalink) continue;

    const websiteUrl = await fetchOrganizationWebsite(org.permalink, apiKey);

    prospects.push({
      companyName: org.value,
      domain: extractDomain(websiteUrl),
      websiteUrl,
      industry: 'saas',
      location: { city: query.geography, country: null, lat: null, lng: null },
      companySize: 'unknown',
      source: 'crunchbase',
      sourceUrl: `https://www.crunchbase.com/organization/${org.permalink}`,
      discoveredAt: new Date(),
      signal: {
        type: 'funding_event',
        description: 'Recently announced funding round',
        evidence: formatFundingEvidence(
          entity.properties.money_raised?.value_usd,
          entity.properties.investment_type,
          entity.properties.announced_on
        ),
        strength: 'strong',
      },
    });
  }

  return { ok: true, prospects };
}
