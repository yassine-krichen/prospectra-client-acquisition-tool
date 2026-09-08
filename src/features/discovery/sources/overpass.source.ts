import { z } from 'zod';

import { mapInBatches } from '@/common/async/map-in-batches';
import { buildNoSignalDetectedFallback, detectWebsiteSignals } from '@/features/discovery/signal-detection';
import { extractDomain } from '@/features/discovery/normalize-domain';
import { geocodeToOsmArea, OSM_USER_AGENT } from '@/features/discovery/sources/geocode-nominatim';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// A broad category+geography combo easily returns thousands of OSM elements
// (confirmed live 2026-08-22: "cafe" in "New York" returned 2,595 elements,
// 1,285 with a website tag) - `mapElementToProspect` fetches each tagged
// website to check it for signals, and doing that one at a time made a
// single run take 20+ minutes even after fetchSafely got its own timeout
// (bounded per-request, not bounded in aggregate). Processed in fixed-size
// concurrent batches instead - each element still only ever gets fetched by
// this app once, this just stops waiting for one before starting the next.
const ELEMENT_MAPPING_CONCURRENCY = 10;

interface OsmTag {
  key: string;
  value: string;
}

// Overpass is tag-based, not free-text search - this maps common category
// keywords to the OSM tag that actually identifies that kind of business.
// Deliberately small and specific to the categories this app's discovery
// form is actually used with; anything not covered here falls back to a
// noisier name-regex search (see `buildFallbackQuery`).
const CATEGORY_TAG_MAP: { keywords: string[]; tag: OsmTag }[] = [
  { keywords: ['plumber'], tag: { key: 'craft', value: 'plumber' } },
  { keywords: ['mechanic', 'auto repair', 'car repair'], tag: { key: 'shop', value: 'car_repair' } },
  { keywords: ['electrician'], tag: { key: 'craft', value: 'electrician' } },
  { keywords: ['restaurant'], tag: { key: 'amenity', value: 'restaurant' } },
  { keywords: ['cafe', 'coffee'], tag: { key: 'amenity', value: 'cafe' } },
  { keywords: ['dentist'], tag: { key: 'amenity', value: 'dentist' } },
  { keywords: ['hair salon', 'barber', 'hairdresser'], tag: { key: 'shop', value: 'hairdresser' } },
  { keywords: ['bakery'], tag: { key: 'shop', value: 'bakery' } },
  { keywords: ['gym', 'fitness'], tag: { key: 'leisure', value: 'fitness_centre' } },
];

// Generic tag keys searched by the name-regex fallback when `category`
// doesn't match anything in `CATEGORY_TAG_MAP` - covers the vast majority of
// small-business POIs on OSM without needing a keyword for every possible
// category.
const FALLBACK_TAG_KEYS = ['shop', 'amenity', 'craft', 'office'];

function resolveOsmTag(category: string): OsmTag | null {
  const normalized = category.trim().toLowerCase();
  const match = CATEGORY_TAG_MAP.find(({ keywords }) => keywords.some((keyword) => normalized.includes(keyword)));
  return match?.tag ?? null;
}

// Overpass QL string literals are double-quoted; escape both regex
// metacharacters (so the category string is matched literally, not
// interpreted as a pattern) and the quote/backslash characters that would
// otherwise break out of the literal.
function escapeForOverpassRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"');
}

function buildTagQuery(areaId: number, tag: OsmTag): string {
  return `
[out:json][timeout:25];
area(${areaId})->.searchArea;
(
  node["${tag.key}"="${tag.value}"](area.searchArea);
  way["${tag.key}"="${tag.value}"](area.searchArea);
);
out center tags;`;
}

function buildFallbackQuery(areaId: number, category: string): string {
  const pattern = escapeForOverpassRegex(category.trim());
  const clauses = FALLBACK_TAG_KEYS.flatMap((key) => [
    `  node["${key}"]["name"~"${pattern}",i](area.searchArea);`,
    `  way["${key}"]["name"~"${pattern}",i](area.searchArea);`,
  ]).join('\n');

  return `
[out:json][timeout:25];
area(${areaId})->.searchArea;
(
${clauses}
);
out center tags;`;
}

const overpassElementSchema = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const overpassResponseSchema = z.object({
  elements: z.array(overpassElementSchema).default([]),
});

/**
 * Builds a street address from OSM's `addr:*` tags, or `null` when none of
 * them are present. OSM tag coverage varies heavily by region - many
 * elements will have a name but no address (or no phone/website) at all;
 * that's expected data sparsity, not a parsing bug.
 */
function buildAddress(tags: Record<string, string>): string | null {
  const parts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const cityAndPostcode = [tags['addr:city'], tags['addr:postcode']].filter(Boolean).join(' ');
  const address = [parts, cityAndPostcode].filter(Boolean).join(', ');
  return address || null;
}

async function mapElementToProspect(
  element: z.infer<typeof overpassElementSchema>,
  query: DiscoveryQuery
): Promise<DiscoveredProspect | null> {
  const tags = element.tags ?? {};
  const companyName = tags.name;
  // Unnamed POIs (very common on OSM - a node tagged shop=car_repair with no
  // `name`) aren't actionable as an outreach target, so they're skipped
  // rather than surfaced with a placeholder name.
  if (!companyName) return null;

  const websiteUrl = tags.website ?? tags['contact:website'] ?? null;
  const phone = tags.phone ?? tags['contact:phone'] ?? null;
  const address = buildAddress(tags);

  const lat = element.lat ?? element.center?.lat ?? null;
  const lng = element.lon ?? element.center?.lon ?? null;

  const signal = websiteUrl
    ? ((await detectWebsiteSignals(websiteUrl)) ?? buildNoSignalDetectedFallback(websiteUrl))
    : { type: 'no_website' as const, description: 'No website tagged on OpenStreetMap', evidence: null, strength: 'strong' as const };

  return {
    companyName,
    domain: extractDomain(websiteUrl),
    websiteUrl,
    industry: 'local_service',
    location: { city: query.geography, country: null, lat, lng },
    companySize: 'unknown',
    source: 'overpass',
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    discoveredAt: new Date(),
    phone,
    address,
    corroboratingSourceCount: 1,
    signal,
  };
}

/**
 * Discovers businesses via OpenStreetMap's Overpass API: geocodes
 * `query.geography` to an OSM area via Nominatim (see `geocode-nominatim.ts`),
 * maps `query.category` to an OSM tag (falling back to a noisier name-regex
 * search across common business tag keys when no mapping exists), and maps
 * matching elements to prospects. Returns a typed "unavailable" result -
 * rather than throwing - when geocoding or the Overpass request fails, so
 * a bad geography string or a down Overpass instance doesn't crash discovery.
 *
 * `onElementProgress`, when provided, is called once per concurrency batch
 * with a human-readable "checked X/Y" message - a broad category+geography
 * combo can return thousands of elements (see `ELEMENT_MAPPING_CONCURRENCY`'s
 * doc comment), and that phase alone can run several minutes, so the
 * dashboard's console panel (discovery.service.ts's `onProgress`) has
 * something to show for it instead of one long silent step.
 */
export async function runOverpassSource(
  query: DiscoveryQuery,
  onElementProgress?: (message: string) => void
): Promise<SourceResult> {
  const area = await geocodeToOsmArea(query.geography);
  if (!area) {
    return { ok: false, reason: 'source unavailable: could not resolve geography to a location' };
  }

  const tag = resolveOsmTag(query.category);
  const overpassQuery = tag ? buildTagQuery(area.areaId, tag) : buildFallbackQuery(area.areaId, query.category);

  let response: Response;
  try {
    // Native `fetch` has no default timeout - without an explicit one here,
    // a slow/overloaded public Overpass instance stalls the whole discovery
    // run indefinitely rather than degrading (confirmed live 2026-08-22).
    // The query's own `[timeout:25]` is a server-side hint asking Overpass
    // to abort ITS processing after 25s - it doesn't bound how long the
    // client waits for a response, hence this separate client-side timeout,
    // set a bit longer to give the server a chance to honor its own hint
    // and respond (even with an error) before this gives up on it too.
    response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': OSM_USER_AGENT, 'Content-Type': 'text/plain' },
      body: overpassQuery,
      signal: AbortSignal.timeout(35_000),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: Overpass request failed (${(error as Error).message})`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `source unavailable: Overpass responded with ${response.status}` };
  }

  const parsed = overpassResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: Overpass response did not match the expected shape' };
  }

  const totalElements = parsed.data.elements.length;
  onElementProgress?.(`found ${totalElements} OSM element(s), checking each one's website…`);

  let foundSoFar = 0;
  const mapped = await mapInBatches(
    parsed.data.elements,
    ELEMENT_MAPPING_CONCURRENCY,
    (element) => mapElementToProspect(element, query),
    (processed, total, batchResults) => {
      foundSoFar += batchResults.filter((prospect) => prospect !== null).length;
      onElementProgress?.(`checked ${processed}/${total} element(s), ${foundSoFar} prospect(s) so far`);
    }
  );
  const prospects = mapped.filter((prospect): prospect is DiscoveredProspect => prospect !== null);

  return { ok: true, prospects };
}
