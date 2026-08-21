import { z } from 'zod';

import { env } from '@/common/config/env';
import { extractDomain, normalizeDomain } from '@/features/discovery/normalize-domain';
import type { DiscoveredProspect } from '@/features/discovery/discovery.types';
import type { Signal } from '@/features/prospects/prospect.types';

const GITHUB_API_BASE_URL = 'https://api.github.com';

// Repos are checked most-recently-pushed first, capped to this many per
// account, to bound API cost per prospect - see `lookupGitHubEvidence`'s doc
// comment.
const REPOS_CHECKED_PER_ACCOUNT = 3;

// Unauthenticated GitHub API calls are capped at 60 requests/hour. Each repo
// can cost up to 3 requests (README, then - only if no hiring signal was
// found - CI-workflows + root-contents checked together), so a per-prospect
// enrichment pass stops picking up new repos once the last-seen
// `x-ratelimit-remaining` count drops to (or below) the most any single
// remaining repo could still cost, rather than pressing on and exhausting
// the tier mid-run.
const RATE_LIMIT_SAFETY_MARGIN = 3;

const HIRING_KEYWORD_PATTERN = /\b(we'?re hiring|hiring now|now hiring|looking for (a )?(contributor|maintainer)s?)\b/i;
const TEST_DIRECTORY_NAMES = new Set(['test', 'tests', '__tests__', 'spec']);

// Minimal subset of GitHub's org/user profile response this source relies
// on: `login` (to build repo-list URLs) and `blog` (the account's declared
// website, used to verify a slug match is actually the prospect's company -
// see `accountMatchesDomain`). Same shape for both `/orgs/:slug` and
// `/users/:slug` - GitHub returns `blog` on both.
const accountSchema = z.object({
  login: z.string(),
  blog: z.string().nullable().optional(),
});

const accountRepoSchema = z.object({
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable(),
  html_url: z.string(),
  homepage: z.string().nullable(),
});
const accountReposResponseSchema = z.array(accountRepoSchema);

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

/** Tracks GitHub's own rate-limit state across every call made in one
 * `lookupGitHubEvidence` invocation - the account lookup(s), the repo list,
 * and every per-repo hiring/stack-gap check, not just one bounded call. */
interface RateLimitState {
  /** Last-seen `x-ratelimit-remaining` value, or `null` if never reported. */
  remaining: number | null;
  /** Set once any call in this run has been refused with a 403. */
  limited: boolean;
}

function rateLimitExhausted(state: RateLimitState): boolean {
  return state.limited || (state.remaining !== null && state.remaining <= RATE_LIMIT_SAFETY_MARGIN);
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
  // A 404 means no workflows directory - no CI configured. Any other
  // non-2xx (rate limit, private repo, etc) is treated as "unknown", not
  // "no CI", so this doesn't fabricate a signal from an inconclusive check.
  // A 403 specifically also flips `rateLimitState.limited`, which the caller
  // uses to stop picking up further repos this run - it's never treated as
  // "no CI" either, since that would mask the rate-limit condition entirely.
  if (!response) return true; // network error: assume CI present rather than flag a false signal
  recordRateLimitState(response, rateLimitState);
  if (response.status === 404) return false;
  return true;
}

/**
 * Scans a repo for a hiring/contributor-wanted keyword in its README or
 * description. Checked before the stack-gap signal below - an explicit
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
 * provider, tests could live in a non-standard path) - this is a heuristic,
 * same caveat as `stale-stack-rules.ts`'s BuiltWith-derived rules.
 */
async function detectStackGapSignal(fullName: string, headers: HeadersInit, rateLimitState: RateLimitState): Promise<Signal | null> {
  const [hasCi, rootContents] = await Promise.all([
    hasCiWorkflows(fullName, headers, rateLimitState),
    fetchRootContents(fullName, headers, rateLimitState),
  ]);

  const hasTestDirectory =
    rootContents === null
      ? true // inconclusive - don't flag a false signal off a failed contents fetch
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
 * Slugifies a domain to a candidate GitHub org/user login: strips a leading
 * `www.` (already done by `normalizeDomain`) and takes the first label -
 * `acme.com` -> `acme`, `acme.co.uk` -> `acme`. A cheap heuristic, not a
 * guarantee - `accountMatchesDomain` is what actually confirms the match,
 * this just picks which account to look up.
 */
function domainToAccountSlug(domain: string): string {
  return normalizeDomain(domain).split('.')[0];
}

async function fetchAccount(
  kind: 'orgs' | 'users',
  slug: string,
  headers: HeadersInit,
  rateLimitState: RateLimitState
): Promise<z.infer<typeof accountSchema> | null> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/${kind}/${slug}`, { headers }).catch(() => null);
  if (!response) return null;
  recordRateLimitState(response, rateLimitState);
  if (!response.ok) return null;

  const parsed = accountSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

async function fetchAccountRepos(
  kind: 'orgs' | 'users',
  slug: string,
  headers: HeadersInit,
  rateLimitState: RateLimitState
): Promise<Array<z.infer<typeof accountRepoSchema>>> {
  const url = new URL(`${GITHUB_API_BASE_URL}/${kind}/${slug}/repos`);
  url.searchParams.set('sort', 'pushed');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('per_page', String(REPOS_CHECKED_PER_ACCOUNT));

  const response = await fetch(url, { headers }).catch(() => null);
  if (!response) return [];
  recordRateLimitState(response, rateLimitState);
  if (!response.ok) return [];

  const parsed = accountReposResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : [];
}

/**
 * Confirms an org/user account found by slug is actually the prospect's own
 * company, not an unrelated same-named GitHub account - the account's
 * declared `blog` (website) field must resolve to the same normalized
 * domain as the prospect's own domain.
 */
function accountMatchesDomain(account: z.infer<typeof accountSchema>, prospectDomain: string): boolean {
  const accountDomain = extractDomain(account.blog ?? null);
  return accountDomain !== null && accountDomain === normalizeDomain(prospectDomain);
}

export interface GitHubEvidenceLookup {
  /** True once an org/user account was found whose declared website
   * confirms it belongs to the prospect - see `accountMatchesDomain`. */
  matched: boolean;
  /** null when no account matched, or a matched account's repos yielded no
   * hiring/stack-gap signal. */
  signal: Signal | null;
}

export type GitHubEvidenceResult = { ok: true; lookup: GitHubEvidenceLookup } | { ok: false; reason: string };

/**
 * Looks up technical evidence for an *already-discovered* prospect via
 * GitHub, rather than independently discovering one (GitHub previously ran
 * as a topic-search discovery source - re-architected to enrichment-only,
 * see docs/discovery-engine-roadmap.md item 3, mirroring how BuiltWith is
 * already scoped). Matching strategy: slugify `prospect.domain` to a
 * candidate org/user login (`acme.com` -> `acme`), try `GET /orgs/<slug>`
 * then `GET /users/<slug>` (cheap exact-lookup calls, not the search API),
 * and confirm the returned account's `blog` field actually resolves to the
 * prospect's domain before treating it as a real match - this avoids a
 * false-positive collision with an unrelated same-named account. Once
 * matched, the account's top `REPOS_CHECKED_PER_ACCOUNT` most-recently-
 * pushed repos are checked for a hiring signal or, failing that, a
 * stack-gap signal, reusing the existing `detectHiringSignal`/
 * `detectStackGapSignal` helpers unchanged. `GITHUB_TOKEN` is optional:
 * unlike the other Branch B/enrichment sources, this one still runs
 * unauthenticated, just at GitHub's much lower unauthenticated rate limit,
 * so its absence is never reported as "unavailable".
 */
export async function lookupGitHubEvidence(prospect: DiscoveredProspect): Promise<GitHubEvidenceResult> {
  if (!prospect.domain) return { ok: true, lookup: { matched: false, signal: null } };

  const headers = buildHeaders(env.GITHUB_TOKEN);
  const slug = domainToAccountSlug(prospect.domain);
  const rateLimitState: RateLimitState = { remaining: null, limited: false };

  let account = await fetchAccount('orgs', slug, headers, rateLimitState);
  let kind: 'orgs' | 'users' = 'orgs';
  if (!account) {
    account = await fetchAccount('users', slug, headers, rateLimitState);
    kind = 'users';
  }

  if (!account || !accountMatchesDomain(account, prospect.domain)) {
    return { ok: true, lookup: { matched: false, signal: null } };
  }

  if (rateLimitExhausted(rateLimitState)) {
    return { ok: true, lookup: { matched: true, signal: null } };
  }

  const repos = await fetchAccountRepos(kind, slug, headers, rateLimitState);

  for (const repo of repos) {
    if (rateLimitExhausted(rateLimitState)) break;

    const signal =
      (await detectHiringSignal(repo.description, repo.full_name, headers, rateLimitState)) ??
      (await detectStackGapSignal(repo.full_name, headers, rateLimitState));

    if (signal) return { ok: true, lookup: { matched: true, signal } };
  }

  return { ok: true, lookup: { matched: true, signal: null } };
}
