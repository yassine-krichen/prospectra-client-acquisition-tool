import { z } from 'zod';

import { env } from '@/common/config/env';
import { prisma } from '@/common/db/client';
import { detectStaleStackSignal } from '@/features/discovery/stale-stack-rules';
import type { Signal } from '@/features/prospects/prospect.types';

const BUILTWITH_DOMAIN_API_URL = 'https://api.builtwith.com/v21/api.json';

const USAGE_SOURCE_KEY = 'builtwith';

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM", UTC
}

/**
 * Atomically reserves one unit of this month's BuiltWith quota
 * (`env.BUILTWITH_MONTHLY_CAP` - see its doc comment in env.ts for why this
 * is a configurable default rather than a verified number like Hunter's).
 * Same race-safety shape as `reserveHunterQuota` in hunter.source.ts: the
 * `count: { lt: cap }` condition is evaluated by Postgres as part of the
 * UPDATE itself, so concurrent callers (e.g. a broad discovery run's
 * bounded-but-parallel batches) can't both slip through past the cap the
 * way a separate read-then-write would allow.
 */
async function reserveBuiltWithQuota(): Promise<boolean> {
  const yearMonth = currentYearMonth();

  // `createMany` + `skipDuplicates`, NOT `upsert` - see the doc comment on
  // the identical fix in daily-send-counter.ts's `reserveDailySendSlot`
  // (`upsert` is not itself safe against a genuine concurrent burst of
  // callers racing to create the same row; caught live by a real
  // concurrent-load test against Postgres). A broad discovery run's own
  // bounded-but-parallel batches are exactly this kind of burst.
  await prisma.apiUsageCounter.createMany({
    data: [{ source: USAGE_SOURCE_KEY, yearMonth, count: 0 }],
    skipDuplicates: true,
  });

  const reserved = await prisma.apiUsageCounter.updateMany({
    where: { source: USAGE_SOURCE_KEY, yearMonth, count: { lt: env.BUILTWITH_MONTHLY_CAP } },
    data: { count: { increment: 1 } },
  });

  return reserved.count > 0;
}

/**
 * Compensating rollback for a reserved quota unit - used only when the
 * `fetch` call to BuiltWith itself threw (a network-level failure), meaning
 * the request never reached BuiltWith's servers. Same reasoning as
 * `rollBackHunterQuota` in hunter.source.ts: NOT used for non-2xx responses
 * or shape mismatches, since BuiltWith's API did receive and likely already
 * billed those.
 */
async function rollBackBuiltWithQuota(): Promise<void> {
  const yearMonth = currentYearMonth();

  await prisma.apiUsageCounter.updateMany({
    where: { source: USAGE_SOURCE_KEY, yearMonth, count: { gt: 0 } },
    data: { count: { decrement: 1 } },
  });
}

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
 * a typed, legible reason when the API key is missing or the call errors -
 * never throws.
 */
export async function lookupStaleStack(domain: string): Promise<StaleStackResult> {
  const apiKey = env.BUILTWITH_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'source unavailable: BUILTWITH_API_KEY not configured' };
  }

  if (!(await reserveBuiltWithQuota())) {
    return {
      ok: false,
      reason: `source unavailable: BuiltWith monthly cap (${env.BUILTWITH_MONTHLY_CAP}/month) already used this month`,
    };
  }

  const url = new URL(BUILTWITH_DOMAIN_API_URL);
  url.searchParams.set('KEY', apiKey);
  url.searchParams.set('LOOKUP', domain);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    await rollBackBuiltWithQuota();
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
