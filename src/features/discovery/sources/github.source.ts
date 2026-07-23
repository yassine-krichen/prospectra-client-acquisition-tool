import { z } from 'zod';

import { env } from '@/common/config/env';
import { extractDomain } from '@/features/discovery/normalize-domain';
import type { DiscoveredProspect, DiscoveryQuery, SourceResult } from '@/features/discovery/discovery.types';
import type { Signal } from '@/features/prospects/prospect.types';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const REPOS_PER_QUERY = 20;

// Unauthenticated GitHub API calls are capped at 60 requests/hour. Each repo
// can cost up to 3 requests (README, then — only if no hiring signal was
// found — CI-workflows + root-contents checked together), so this run stops
// picking up new repos once the last-seen `x-ratelimit-remaining` count
// drops to (or below) the most any single remaining repo could still cost,
// rather than pressing on and exhausting the tier mid-run.
const RATE_LIMIT_SAFETY_MARGIN = 3;

// GitHub search only looks at repos pushed within this window — "recent
// commits" per the spec, not the whole repo's lifetime history.
const RECENT_PUSH_WINDOW_DAYS = 30;

const HIRING_KEYWORD_PATTERN = /\b(we'?re hiring|hiring now|now hiring|looking for (a )?(contributor|maintainer)s?)\b/i;
const TEST_DIRECTORY_NAMES = new Set(['test', 'tests', '__tests__', 'spec']);

const repoSearchItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable(),
  html_url: z.string(),
  homepage: z.string().nullable(),
});

const repoSearchResponseSchema = z.object({
  items: z.array(repoSearchItemSchema).default([]),
  message: z.string().optional(),
});

const readmeResponseSchema = z.object({
  content: z.string(),
  encoding: z.string(),
});

const contentsEntrySchema = z.object({ name: z.string(), type: z.string() });
const contentsResponseSchema = z.array(contentsEntrySchema);

function buildHeaders(token: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    // GitHub requires a User-Agent on every API request, authenticated or not.
    'User-Agent': 'biz-scraper-discovery',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Tracks GitHub's own rate-limit state across every call made in one `runGitHubSource` invocation. */
interface RateLimitState {
  /** Last-seen `x-ratelimit-remaining` value, or `null` if never reported. */
  remaining: number | null;
  /** Set once any call in this run has been refused with a 403. */
  limited: boolean;
}

/**
 * Reads GitHub's rate-limit bookkeeping off a response: the
 * `x-ratelimit-remaining` header (when present) and a 403 status (GitHub's
 * signal for "rate limit exceeded" on this unauthenticated/low-quota tier,
 * as distinct from a genuine 404 "not found"). Mutates `state` in place so
 * every helper below shares one running picture of the budget without
 * threading a return value through every call site.
 */
function recordRateLimitState(response: Response, state: RateLimitState): void {
  if (response.status === 403) state.limited = true;

  const header = typeof response.headers?.get === 'function' ? response.headers.get('x-ratelimit-remaining') : null;
  if (header === null) return;
  const value = Number(header);
  if (!Number.isNaN(value)) state.remaining = value;
}

async function fetchReadmeText(fullName: string, headers: HeadersInit, rateLimitState: RateLimitState): Promise<string | null> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${fullName}/readme`, { headers }).catch(() => null);
  if (!response) return null;
  recordRateLimitState(response, rateLimitState);
  if (!response.ok) return null;

  const parsed = readmeResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.encoding !== 'base64') return null;

  return Buffer.from(parsed.data.content, 'base64').toString('utf8');
}

async function fetchRootContents(
  fullName: string,
  headers: HeadersInit,
  rateLimitState: RateLimitState
): Promise<Array<z.infer<typeof contentsEntrySchema>> | null> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${fullName}/contents/`, { headers }).catch(() => null);
  if (!response) return null;
  recordRateLimitState(response, rateLimitState);
  if (!response.ok) return null;

  const parsed = contentsResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

async function hasCiWorkflows(fullName: string, headers: HeadersInit, rateLimitState: RateLimitState): Promise<boolean> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${fullName}/contents/.github/workflows`, {
    headers,
  }).catch(() => null);
  // A 404 means no workflows directory — no CI configured. Any other
  // non-2xx (rate limit, private repo, etc) is treated as "unknown", not
  // "no CI", so this doesn't fabricate a signal from an inconclusive check.
  // A 403 specifically also flips `rateLimitState.limited`, which the caller
  // uses to stop picking up further repos this run — it's never treated as
  // "no CI" either, since that would mask the rate-limit condition entirely.
  if (!response) return true; // network error: assume CI present rather than flag a false signal
  recordRateLimitState(response, rateLimitState);
  if (response.status === 404) return false;
  return true;
}

/**
 * Scans a repo for a hiring/contributor-wanted keyword in its README or
 * description. Checked before the stack-gap signal below — an explicit
 * "we're hiring" mention is stronger, more actionable evidence than an
 * absence of CI/tests.
 */
async function detectHiringSignal(
  description: string | null,
  fullName: string,
  headers: HeadersInit,
  rateLimitState: RateLimitState
): Promise<Signal | null> {
  if (description && HIRING_KEYWORD_PATTERN.test(description)) {
    return {
      type: 'hiring_post',
      description: 'Hiring/contributor-wanted keyword found in repo description',
      evidence: description,
      strength: 'medium',
    };
  }

  const readme = await fetchReadmeText(fullName, headers, rateLimitState);
  if (readme && HIRING_KEYWORD_PATTERN.test(readme)) {
    const match = readme.match(HIRING_KEYWORD_PATTERN);
    return {
      type: 'hiring_post',
      description: 'Hiring/contributor-wanted keyword found in README',
      evidence: match?.[0] ?? null,
      strength: 'medium',
    };
  }

  return null;
}

/**
 * Approximates technical-debt via two absence checks: no `.github/workflows`
 * (no CI) and no root-level test directory (no tests). Neither check proves
 * the repo truly lacks CI/tests elsewhere (CI could live in another
 * provider, tests could live in a non-standard path) — this is a heuristic,
 * same caveat as `stale-stack-rules.ts`'s BuiltWith-derived rules.
 */
async function detectStackGapSignal(fullName: string, headers: HeadersInit, rateLimitState: RateLimitState): Promise<Signal | null> {
  const [hasCi, rootContents] = await Promise.all([
    hasCiWorkflows(fullName, headers, rateLimitState),
    fetchRootContents(fullName, headers, rateLimitState),
  ]);

  const hasTestDirectory =
    rootContents === null
      ? true // inconclusive — don't flag a false signal off a failed contents fetch
      : rootContents.some((entry) => entry.type === 'dir' && TEST_DIRECTORY_NAMES.has(entry.name.toLowerCase()));

  if (hasCi && hasTestDirectory) return null;

  const missing = [!hasCi ? 'no .github/workflows CI config' : null, !hasTestDirectory ? 'no root test directory' : null]
    .filter((value): value is string => value !== null)
    .join(', ');

  return {
    type: 'technical_debt',
    description: 'Missing CI and/or test directory',
    evidence: missing,
    strength: !hasCi && !hasTestDirectory ? 'medium' : 'weak',
  };
}

/**
 * Searches GitHub for repos matching `query.category` as a topic keyword,
 * pushed within the last `RECENT_PUSH_WINDOW_DAYS` days, then checks each
 * for a hiring signal (README/description keyword scan) or, failing that, a
 * stack-gap signal (missing CI/tests). `query.geography` is ignored — repo
 * activity has no location. `GITHUB_TOKEN` is optional: unlike the other
 * Branch B sources, this one still runs unauthenticated, just at GitHub's
 * much lower unauthenticated rate limit, so its absence is never reported
 * as "unavailable".
 */
export async function runGitHubSource(query: DiscoveryQuery): Promise<SourceResult> {
  const headers = buildHeaders(env.GITHUB_TOKEN);
  const pushedAfter = new Date(Date.now() - RECENT_PUSH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const url = new URL(`${GITHUB_API_BASE_URL}/search/repositories`);
  url.searchParams.set('q', `topic:${query.category} pushed:>${pushedAfter}`);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(REPOS_PER_QUERY));

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    return {
      ok: false,
      reason: `source unavailable: GitHub request failed (${(error as Error).message})`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `source unavailable: GitHub responded with ${response.status}` };
  }

  const rateLimitState: RateLimitState = { remaining: null, limited: false };
  recordRateLimitState(response, rateLimitState);

  const parsed = repoSearchResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, reason: 'source unavailable: GitHub response did not match the expected shape' };
  }

  const prospects: DiscoveredProspect[] = [];
  let processedCount = 0;
  let stoppedForRateLimit = false;

  for (const repo of parsed.data.items) {
    // Stop picking up new repos once GitHub itself has refused a call with a
    // 403 (`limited`), or once the last-reported remaining budget is too
    // thin to safely cover another repo's worth of calls — rather than
    // pressing on and exhausting the unauthenticated tier mid-run.
    if (rateLimitState.limited || (rateLimitState.remaining !== null && rateLimitState.remaining <= RATE_LIMIT_SAFETY_MARGIN)) {
      stoppedForRateLimit = true;
      break;
    }

    const signal =
      (await detectHiringSignal(repo.description, repo.full_name, headers, rateLimitState)) ??
      (await detectStackGapSignal(repo.full_name, headers, rateLimitState));
    processedCount += 1;

    if (!signal) continue;

    prospects.push({
      companyName: repo.name,
      domain: extractDomain(repo.homepage),
      websiteUrl: repo.homepage,
      industry: 'saas',
      location: { city: null, country: null, lat: null, lng: null },
      companySize: 'unknown',
      source: 'github',
      sourceUrl: repo.html_url,
      discoveredAt: new Date(),
      signal,
      projectFit: 'unclear',
      estimatedBudget: 'unknown',
    });
  }

  if (stoppedForRateLimit) {
    return {
      ok: true,
      prospects,
      degradedReason: `GitHub rate limit reached after processing ${processedCount}/${parsed.data.items.length} repos this run — remaining repos were skipped rather than risk exhausting the unauthenticated tier`,
    };
  }

  return { ok: true, prospects };
}
