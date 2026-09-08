import { z } from 'zod';

// Resolves a free-text geography string (e.g. "Austin, TX") to an Overpass
// area-id via Nominatim, OSM's free geocoder - Overpass QL itself has no
// free-text geography search, only tag queries scoped to a known area.
//
// Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
// requires a real, descriptive User-Agent identifying the calling application
// (not a browser UA) and caps usage at roughly 1 request/second - this module
// is called at most once per discovery run per query, well under that.

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

// Shared across every OSM-family request this app makes (Nominatim here, and
// Overpass in overpass.source.ts) - both are run by the OSM community and
// both reject/406 requests that don't identify themselves with a real,
// descriptive User-Agent (not a browser UA, not the runtime's default).
export const OSM_USER_AGENT = 'biz-scraper/1.0 (cold-outreach discovery pipeline)';

// Overpass's `area()` query element expects an area-id, not a raw OSM
// id/type pair - relations and ways are offset by these fixed conventions
// documented at https://wiki.openstreetmap.org/wiki/Overpass_API/Areas
// ("Relation areas get an id of 3600000000+relation_id, way areas get
// 2400000000+way_id"). Nodes have no area equivalent and can't be geocoded
// into a search area this way.
const OVERPASS_RELATION_AREA_OFFSET = 3_600_000_000;
const OVERPASS_WAY_AREA_OFFSET = 2_400_000_000;

const nominatimResultSchema = z.object({
  osm_type: z.enum(['relation', 'way', 'node']),
  osm_id: z.number(),
});

const nominatimResponseSchema = z.array(nominatimResultSchema);

export interface GeocodedArea {
  areaId: number;
}

/**
 * Resolves `geography` to an Overpass area-id via Nominatim. Returns `null`
 * (rather than throwing) when geocoding fails, the request errors, or the
 * top result is a `node` (nodes have no Overpass area representation) - so a
 * bad/unresolvable geography string degrades to "this source found nothing"
 * instead of crashing discovery.
 */
export async function geocodeToOsmArea(geography: string): Promise<GeocodedArea | null> {
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set('q', geography);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  let response: Response;
  try {
    // Native `fetch` has no default timeout - without this, a slow/hung
    // public Nominatim instance stalls the whole discovery run
    // indefinitely (confirmed live 2026-08-22: a run got stuck on
    // "overpass: running…" with no further progress and no error, ever).
    response = await fetch(url, {
      headers: { 'User-Agent': OSM_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const parsed = nominatimResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.length === 0) return null;

  const [top] = parsed.data;
  if (top.osm_type === 'relation') return { areaId: OVERPASS_RELATION_AREA_OFFSET + top.osm_id };
  if (top.osm_type === 'way') return { areaId: OVERPASS_WAY_AREA_OFFSET + top.osm_id };

  return null; // A `node` result has no Overpass area representation.
}
