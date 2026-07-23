import { z } from 'zod';

import { env } from '@/common/config/env';
import { prisma } from '@/common/db/client';
import type { EnrichmentInput, EnrichmentResult } from '@/features/enrichment/enrichment.types';

const EMAIL_FINDER_URL = 'https://api.hunter.io/v2/email-finder';
const DOMAIN_SEARCH_URL = 'https://api.hunter.io/v2/domain-search';

const USAGE_SOURCE_KEY = 'hunter';
// Hunter.io's free tier is capped at 25 searches/month — a hard external
// quota, not something this code can bypass. `ApiUsageCounter` tracks calls
// per calendar month so the code refuses to call Hunter past the cap rather
// than burning it on calls that fail after the fact.
const MONTHLY_FREE_TIER_CAP = 25;

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM", UTC
}

/**
 * Atomically reserves one unit of this month's Hunter quota. Returns `false`
 * (without making the Hunter call) once `MONTHLY_FREE_TIER_CAP` has already
 * been reserved this month. The `count: { lt: cap }` condition is evaluated
 * by Postgres as part of the UPDATE itself, so concurrent callers can't both
 * slip through past the cap the way a separate read-then-write would allow.
 */
async function reserveHunterQuota(): Promise<boolean> {
  const yearMonth = currentYearMonth();

  await prisma.apiUsageCounter.upsert({
    where: { source_yearMonth: { source: USAGE_SOURCE_KEY, yearMonth } },
    create: { source: USAGE_SOURCE_KEY, yearMonth, count: 0 },
    update: {},
  });

  const reserved = await prisma.apiUsageCounter.updateMany({
    where: { source: USAGE_SOURCE_KEY, yearMonth, count: { lt: MONTHLY_FREE_TIER_CAP } },
    data: { count: { increment: 1 } },
  });

  return reserved.count > 0;
}

/**
 * Compensating rollback for a reserved quota unit — used only when the
 * `fetch` call to Hunter itself threw (a network-level failure), meaning the
 * request never reached Hunter's servers, so Hunter could not have counted
 * it against the real account quota. Deliberately NOT used for non-2xx
 * responses, empty results, or shape mismatches: those mean Hunter's API did
 * receive and process the request (and, per Hunter's own billing, likely
 * already counted it), so rolling those back would under-count real usage
 * against this local counter.
 */
async function rollBackHunterQuota(): Promise<void> {
  const yearMonth = currentYearMonth();

  await prisma.apiUsageCounter.updateMany({
    where: { source: USAGE_SOURCE_KEY, yearMonth, count: { gt: 0 } },
    data: { count: { decrement: 1 } },
  });
}

const verificationStatusSchema = z
  .enum(['valid', 'invalid', 'accept_all', 'webmail', 'disposable', 'unknown'])
  .nullable()
  .optional();

const emailFinderResponseSchema = z.object({
  data: z
    .object({
      email: z.string().nullable(),
      score: z.number().nullable().optional(),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
      position: z.string().nullable().optional(),
      linkedin_url: z.string().nullable().optional(),
      verification: z.object({ status: verificationStatusSchema }).nullable().optional(),
    })
    .nullable(),
  errors: z.array(z.object({ details: z.string().optional() })).optional(),
});

const domainSearchEmailSchema = z.object({
  value: z.string(),
  confidence: z.number().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  linkedin: z.string().nullable().optional(),
  verification: z.object({ status: verificationStatusSchema }).nullable().optional(),
});

const domainSearchResponseSchema = z.object({
  data: z
    .object({
      emails: z.array(domainSearchEmailSchema).default([]),
    })
    .nullable(),
  errors: z.array(z.object({ details: z.string().optional() })).optional(),
});

function buildContactName(firstName: string | null | undefined, lastName: string | null | undefined): string | null {
  const parts = [firstName, lastName].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' ') : null;
}

// A "valid" verification status is Hunter's own strongest confidence signal
// — anything else (accept_all, webmail, unknown, etc) means Hunter itself
// isn't certain the mailbox exists, so `emailVerified` only flips to `true`
// on an explicit "valid".
function isVerified(status: string | null | undefined): boolean {
  return status === 'valid';
}

/**
 * Looks up a contact email via Hunter.io: the Email Finder endpoint when a
 * contact name is already known, otherwise the Domain Search endpoint's
 * highest-confidence result. Refuses to call Hunter at all once this
 * calendar month's free-tier quota (`MONTHLY_FREE_TIER_CAP`) is used up.
 * Returns a typed "unavailable" result — rather than throwing — when
 * HUNTER_API_KEY is unset, the quota is exhausted, or the call fails.
 */
export async function runHunterEnrichment(input: EnrichmentInput): Promise<EnrichmentResult> {
  const apiKey = env.HUNTER_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'source unavailable: HUNTER_API_KEY not configured' };
  }

  if (!(await reserveHunterQuota())) {
    return {
      ok: false,
      reason: `source unavailable: Hunter.io free-tier quota (${MONTHLY_FREE_TIER_CAP}/month) already used this month`,
    };
  }

  if (input.contactName) {
    const [firstName, ...rest] = input.contactName.trim().split(/\s+/);
    const lastName = rest.length > 0 ? rest[rest.length - 1] : undefined;

    const url = new URL(EMAIL_FINDER_URL);
    url.searchParams.set('domain', input.domain);
    url.searchParams.set('first_name', firstName);
    if (lastName) url.searchParams.set('last_name', lastName);
    url.searchParams.set('api_key', apiKey);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      await rollBackHunterQuota();
      return { ok: false, reason: `source unavailable: Hunter.io request failed (${(error as Error).message})` };
    }

    if (!response.ok) {
      return { ok: false, reason: `source unavailable: Hunter.io responded with ${response.status}` };
    }

    const parsed = emailFinderResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      return { ok: false, reason: 'source unavailable: Hunter.io response did not match the expected shape' };
    }

    const { data } = parsed.data;
    if (!data || !data.email) {
      return { ok: false, reason: 'source unavailable: Hunter.io found no email for this contact' };
    }
    const email = data.email;

    return {
      ok: true,
      contact: {
        contactName: buildContactName(data.first_name, data.last_name) ?? input.contactName,
        contactTitle: data.position ?? null,
        contactEmail: email,
        emailVerified: isVerified(data.verification?.status),
        emailConfidence: data.score ?? 0,
        linkedinUrl: data.linkedin_url ?? null,
      },
    };
  }

  const url = new URL(DOMAIN_SEARCH_URL);
  url.searchParams.set('domain', input.domain);
  url.searchParams.set('api_key', apiKey);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    await rollBackHunterQuota();
    return { ok: false, reason: `source unavailable: Hunter.io request failed (${(error as Error).message})` };
  }

  if (!response.ok) {
    return { ok: false, reason: `source unavailable: Hunter.io responded with ${response.status}` };
  }

  const parsed = domainSearchResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: Hunter.io response did not match the expected shape' };
  }

  const emails = parsed.data.data?.emails ?? [];
  const best = emails.reduce<(typeof emails)[number] | null>((strongest, candidate) => {
    if (!strongest) return candidate;
    return (candidate.confidence ?? 0) > (strongest.confidence ?? 0) ? candidate : strongest;
  }, null);

  if (!best) {
    return { ok: false, reason: 'source unavailable: Hunter.io found no emails for this domain' };
  }

  return {
    ok: true,
    contact: {
      contactName: buildContactName(best.first_name, best.last_name),
      contactTitle: best.position ?? null,
      contactEmail: best.value,
      emailVerified: isVerified(best.verification?.status),
      emailConfidence: best.confidence ?? 0,
      linkedinUrl: best.linkedin ?? null,
    },
  };
}
