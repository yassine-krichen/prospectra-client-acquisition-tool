import { z } from 'zod';

import { env } from '@/common/config/env';
import { detectStaleStackSignal } from '@/features/discovery/stale-stack-rules';
import type { Signal } from '@/features/prospects/prospect.types';

const BUILTWITH_DOMAIN_API_URL = 'https://api.builtwith.com/v21/api.json';

// Minimal subset of the BuiltWith Domain API response shape we rely on.
// See https://builtwith.com/domain-api for the full (much larger) shape.
const technologySchema = z.object({ Name: z.string() });
const pathSchema = z.object({ Technologies: z.array(technologySchema).default([]) });
const lookupResultSchema = z.object({ Paths: z.array(pathSchema).default([]) });
const lookupSchema = z.object({ Result: lookupResultSchema.optional() });
const builtwithResponseSchema = z.object({
  Results: z.array(lookupSchema).default([]),
  Errors: z.array(z.object({ Message: z.string().optional() })).optional(),
});

export interface StaleStackLookup {
  domain: string;
  technologies: string[];
  /** null when no stale-stack rule fired against the detected tech stack. */
  signal: Signal | null;
}

export type StaleStackResult = { ok: true; lookup: StaleStackLookup } | { ok: false; reason: string };

/**
 * Looks up a domain's tech stack via the BuiltWith Domain API and maps it to
 * a "needs rebuild" signal via `stale-stack-rules.ts`. Fails gracefully with
 * a typed, legible reason when the API key is missing or the call errors —
 * never throws.
 */
export async function lookupStaleStack(domain: string): Promise<StaleStackResult> {
  const apiKey = env.BUILTWITH_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'source unavailable: BUILTWITH_API_KEY not configured' };
  }

  const url = new URL(BUILTWITH_DOMAIN_API_URL);
  url.searchParams.set('KEY', apiKey);
  url.searchParams.set('LOOKUP', domain);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: BuiltWith request failed (${(error as Error).message})`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `source unavailable: BuiltWith responded with ${response.status}` };
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = builtwithResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: BuiltWith response did not match the expected shape' };
  }

  const technologies = parsed.data.Results.flatMap(
    (result) => result.Result?.Paths.flatMap((path) => path.Technologies.map((tech) => tech.Name)) ?? []
  );

  const match = detectStaleStackSignal(technologies);
  const signal: Signal | null = match
    ? {
        type: 'old_stack',
        description: match.description,
        evidence: technologies.length > 0 ? technologies.join(', ') : null,
        strength: match.strength,
      }
    : null;

  return { ok: true, lookup: { domain, technologies, signal } };
}
