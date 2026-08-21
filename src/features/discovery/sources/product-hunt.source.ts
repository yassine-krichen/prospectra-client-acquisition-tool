import { z } from 'zod';

import { env } from '@/common/config/env';
import { extractDomain } from '@/features/discovery/normalize-domain';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';

const PRODUCT_HUNT_GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';

// Product Hunt's search is topic-based, not category+geography like Branch
// A's local/SMB sources. `query.category` is reused as the topic slug (e.g.
// "saas", "developer-tools") and `query.geography` is ignored - Product
// Hunt launches aren't tied to a location, so `location` on every discovered
// prospect is left empty rather than approximated from the query.
const POSTS_PER_QUERY = 20;

const POSTS_QUERY = `
  query DiscoverRecentLaunches($topic: String!, $first: Int!) {
    posts(topic: $topic, order: NEWEST, first: $first) {
      edges {
        node {
          id
          name
          tagline
          url
          website
        }
      }
    }
  }
`;

const postNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string().nullable().optional(),
  url: z.string(),
  website: z.string().nullable().optional(),
});

const postsResponseSchema = z.object({
  data: z
    .object({
      posts: z.object({
        edges: z.array(z.object({ node: postNodeSchema })).default([]),
      }),
    })
    .optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

/**
 * Fetches recently launched products from Product Hunt's GraphQL API,
 * filtered by topic. Returns a typed "unavailable" result - rather than
 * throwing - when PRODUCT_HUNT_API_TOKEN is unset or the API call fails, so
 * one missing key doesn't crash discovery.
 */
export async function runProductHuntSource(query: DiscoveryQuery): Promise<SourceResult> {
  const token = env.PRODUCT_HUNT_API_TOKEN;
  if (!token) {
    return { ok: false, reason: 'source unavailable: PRODUCT_HUNT_API_TOKEN not configured' };
  }

  let response: Response;
  try {
    response = await fetch(PRODUCT_HUNT_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: POSTS_QUERY,
        variables: { topic: query.category, first: POSTS_PER_QUERY },
      }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: Product Hunt request failed (${(error as Error).message})`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `source unavailable: Product Hunt responded with ${response.status}` };
  }

  const parsed = postsResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: Product Hunt response did not match the expected shape' };
  }

  if (!parsed.data.data) {
    const detail = parsed.data.errors?.[0]?.message;
    return {
      ok: false,
      reason: `source unavailable: Product Hunt returned no data${detail ? ` (${detail})` : ''}`,
    };
  }

  const prospects: DiscoveredProspect[] = parsed.data.data.posts.edges.map(({ node }) => ({
    companyName: node.name,
    domain: extractDomain(node.website ?? null),
    websiteUrl: node.website ?? null,
    industry: 'saas',
    location: { city: null, country: null, lat: null, lng: null },
    companySize: 'unknown',
    source: 'product_hunt',
    sourceUrl: node.url,
    discoveredAt: new Date(),
    phone: null,
    address: null,
    corroboratingSourceCount: 1,
    signal: {
      type: 'new_launch',
      description: 'Recently launched on Product Hunt',
      evidence: node.tagline ?? null,
      strength: 'strong',
    },
  }));

  return { ok: true, prospects };
}
