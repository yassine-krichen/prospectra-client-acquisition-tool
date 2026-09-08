# Session Handoff — 2026-08-30

Written at the end of a very long session to survive a context clear. Read this before doing
anything else in a new session. `CLAUDE.md` at the repo root is still the primary reference for
how the app works — this file is about *this session's* work specifically: what changed, why, what's
still broken, what's still open.

## Current project state

- **Branch**: `main`. Local `main` is exactly in sync with `origin/main` at commit `4a52b1b`
  ("fixed discovery , major issues , added filter and tests") — **no branches, no PRs in flight.**
- **Uncommitted right now**: exactly one file, `src/features/prospects/prospects-table.tsx` — the
  "last opened prospect" row-highlight feature (see below). Nothing else is dirty.
- **Important**: partway through this session, commit `4a52b1b` appeared on `main` authored by
  the user directly (not by me — no `Co-Authored-By: Claude` trailer), capturing a large chunk of
  this session's in-progress work (discovery fixes, the streaming console, the reason filter) that
  I had built but not yet committed myself. That's why the "files modified" list below is much
  longer than what `git status` shows uncommitted today — most of it is already on `main`.
- **Dev server**: was running on `http://localhost:3000` (PID varies each restart — check with
  `netstat -ano | grep ":3000"` before assuming it's still up) at the end of this session, serving
  the uncommitted highlight-feature code. Two accounts (`Noel`, `EvilWithin`) exist in the DB with
  real passwords already set by the user during testing — **do not reseed or reset them.**
- **Local `.env`** has real keys for: `DATABASE_URL`, `TEST_DATABASE_URL`, `SESSION_SECRET`,
  `CRON_SECRET`, `BUILTWITH_API_KEY`, `COMPANIES_HOUSE_API_KEY`, `TEXAS_COMPTROLLER_API_KEY`,
  `PRODUCT_HUNT_API_TOKEN`, `GITHUB_TOKEN`, `HUNTER_API_KEY`, `PEOPLE_DATA_LABS_API_KEY`,
  `GEMINI_API_KEY`, `GROQ_API_KEY`, `RESEND_API_KEY`, `NEON_API_KEY`, `NEON_PROJECT_ID`. Still
  empty/deliberately unset: `SENDING_DOMAIN`, `DOMAIN_DNS_VERIFIED`, `RESEND_WEBHOOK_SECRET`,
  `CRUNCHBASE_API_KEY`. `GOOGLE_PLACES_API_KEY` is commented out in `.env` (billing not enabled on
  that Google Cloud project — a real key is present in the comment, just disabled).

## What we were trying to accomplish (this session, roughly in order)

1. Verify `main` had actually absorbed all the side branches from prior sessions (it hadn't).
2. Design and ship automated Vercel Cron scheduling for the discover/draft/followup/retention
   pipeline stages, working around Vercel Hobby's once/day-per-job cron limit.
3. Restrict the fully-unattended cron drafting path to strong-signal prospects only.
4. Replace the single shared `DASHBOARD_PASSWORD` with a real two-account (Noel/EvilWithin),
   database-backed auth system, since the dashboard is now publicly hosted on Vercel.
5. Diagnose and fix a Vercel deployment failure (Playwright/Chromium couldn't run in the
   serverless function).
6. Diagnose and fix a real bug where a Discovery run could hang forever (and, once fixed, was
   still impractically slow for broad queries).
7. Fix a silently-broken discovery source (Companies House) surfaced while investigating the above.
8. Add a live, step-by-step console/log panel to the `/discovery` page so a running discovery job
   is no longer an opaque black box.
9. Add a free-text "reason" filter and a "last opened prospect" visual highlight to `/prospects`.

## Everything already implemented (and committed to `main` as of `4a52b1b`, unless noted otherwise)

### 1. Vercel Cron automation
- `vercel.json` — two cron entries: `GET /api/cron/discover` (12:00 UTC), `GET /api/cron/daily`
  (14:00 UTC). Chosen because Hobby plan caps Vercel's own Cron Jobs feature at roughly
  once-a-day-per-job, so per-stage cron jobs were consolidated into two.
- `src/common/auth/cron-auth.ts` — shared `isAuthorizedByCronHeader` (manual `x-cron-secret`
  header, used by every route's `POST`) and `isAuthorizedByCronBearer` (Vercel's own
  `Authorization: Bearer <CRON_SECRET>` convention, used by the two `GET` handlers Vercel Cron
  actually calls). Replaced 4 duplicated `isAuthorized` functions.
- `app/api/cron/daily/route.ts` (new) — chains `draftBatch` → `humanizeBatch` →
  `runFollowupScheduler` → `runRetentionScheduler` in one invocation, `maxDuration = 60`.
- `app/api/cron/discover/route.ts` — added a `GET` handler (Vercel Cron entry point) alongside the
  existing manual `POST`. Cycles through a fixed New York category list deterministically by UTC
  date — see `src/features/discovery/ny-target-categories.ts` (`NY_TARGET_CATEGORIES`,
  `pickDailyCategory`). Categories are deliberately upscale/professional (law firms, dental
  practices, etc.) — low-budget categories excluded on purpose, a business call.
- `draftBatch`/`humanizeBatch` (`src/features/drafting/drafting.service.ts`) gained an optional
  `DraftBatchOptions.signalStrength` filter (Postgres JSON path match). `app/api/cron/daily`
  passes `{ signalStrength: 'strong' }` — the fully-unattended path only ever drafts "High" signal
  prospects. Manual triggering (dashboard Pipeline page, `POST /api/cron/draft-batch`) is
  unaffected.

### 2. Two-account auth system (replaces `DASHBOARD_PASSWORD`)
- **`User` Prisma model** (migration `20260821223000_add_user_auth`): `nickname` (unique),
  `passwordHash` (nullable), `firstLogin{At,Ip,UserAgent,Device,Browser}`,
  `lastLogin{At,Ip,UserAgent,Device,Browser}`.
- `src/features/auth/known-usernames.ts` — the only two nicknames that will ever exist: `Noel`,
  `EvilWithin`. Pure/env-free so it's safe in a `'use client'` bundle.
- `src/common/auth/password-hash.ts` — Node's built-in `scrypt` (no new dependency), exports
  `hashPassword`/`verifyPassword`/`MIN_PASSWORD_LENGTH` (8).
- `src/common/auth/request-metadata.ts` — `getClientIp` (reads `x-forwarded-for`, since
  `NextRequest.ip` doesn't exist in Next 15+) and `parseUserAgent` (hand-rolled, no dependency).
- `src/common/auth/session.ts` — rewritten. Token now carries `userId.nickname.issuedAt.signature`
  (was just `issuedAt.signature`). **Deliberately non-expiring** — `verifySessionToken` has no age
  check at all, per the user's explicit instruction ("dont make the token expire"). Cookie
  `Max-Age` is 400 days purely because that's Chrome's own hard cap on cookie lifetime, not a
  server-side expiry.
- `app/api/login/route.ts` — **this file was rewritten again by someone else after my version**
  (see "Important architectural decisions" below) to add login-lockout and remove a first-login
  race-condition vulnerability. Current behavior: rejects unknown nicknames and nicknames with no
  password set yet (`passwordHash === null`) the same generic way, tracks failed attempts per
  nickname via `src/common/auth/login-lockout.ts` (5 failures → 15 min lockout).
- `app/api/cron/seed-users/route.ts` — **also rewritten after my version**. Originally created
  accounts with `passwordHash: null` and let whoever logged in first claim the account (a real
  vulnerability). Now *requires* `{ passwords: { Noel: '...', EvilWithin: '...' } }` (min 8 chars)
  in the request body up front — a nickname with no valid password in the call is skipped, not
  created with a claimable null password.
- `app/login/page.tsx` — shadcn Command+Popover combobox to pick an account. **Also simplified by
  someone else after my version**: my original had a two-step "first login sets your password"
  flow with a confirm-password field; the current version on `main` is simpler (no
  needsSetup/confirm-password UI at all, since accounts can no longer be created passwordless).
- `app/(dashboard)/layout.tsx`, `dashboard-nav.tsx`, `user-menu.tsx` — sidebar greeting now shows
  the real signed-in nickname (resolved server-side from the session cookie), not a hardcoded
  "Admin".
- Removed `DASHBOARD_PASSWORD` entirely from `env.ts`, `.env.example`, `setup.ps1`, `README.md`.

### 3. Playwright-on-Vercel fix
Root cause: Vercel serverless functions have no Chromium binary at all; the full `playwright`
package's ~300MB+ download can't ship in a function bundle. This threw `Cannot find module
'.../playwright-core/browsers.json'` in production the moment a Playwright-based source
(Yellow Pages, Indie Hackers) ran.
- `src/common/scraping/browser.ts` — `resolveLaunchOptions()` (exported for testability): on
  Vercel/Lambda (`process.env.VERCEL` or `AWS_LAMBDA_FUNCTION_NAME` set), launches via
  `@sparticuz/chromium` (a Lambda-compiled Chromium build) instead of a nonexistent bundled
  browser. Locally, unchanged — `playwright-core` (now the actual runtime import everywhere,
  replacing `playwright`) finds the Chromium the full `playwright` package (moved to
  `devDependencies`) downloads to the shared Playwright browser cache.
- `next.config.ts` — `serverExternalPackages: ["@sparticuz/chromium", "playwright-core"]`, required
  or Next's bundler mangles `@sparticuz/chromium`'s runtime binary lookup.
- `package.json` — added `"engines": { "node": ">=22.17.0" }` (`@sparticuz/chromium`'s
  requirement) — **the user still needs to confirm Vercel's Project Settings → General →
  Node.js Version is actually set to 22.x or later**, since `engines` is a hint, not a guaranteed
  override of that dashboard setting.
- Verified locally via `npx next build` (succeeds) and the full test suite. **Cannot be verified
  end-to-end locally** — `@sparticuz/chromium`'s binary is Linux-only, so the serverless branch
  can only be exercised on an actual Vercel deploy.

### 4. Discovery reliability fixes (the big one)
Triggered by the user reporting a live discovery run stuck forever at `"overpass: running…"`.
- **Root cause**: `fetchSafely()` in `src/common/net/is-safe-fetch-target.ts` (the shared
  SSRF-safe fetch wrapper used by `detectWebsiteSignals`, the tech-stack-detector enricher, and
  Indie Hackers) had **no timeout at all** and no try/catch around its own `fetch()` call. A
  single slow/unresponsive small-business website — very common — stalled whichever discovery run
  touched it, forever, with zero error. Fixed: `AbortSignal.timeout(10_000)` + try/catch, so every
  failure mode (including a timeout) now degrades to `null` as the function's own doc comment
  always claimed it did.
- Same missing-timeout issue existed in `geocode-nominatim.ts` (15s timeout added) and
  `overpass.source.ts`'s own Overpass API fetch (35s timeout added — longer than the query's own
  `[timeout:25]` server-side hint, to give Overpass a chance to honor that hint first).
- **Second, separate problem found by live-testing**: a broad category+geography combo (e.g.
  "cafe" in "New York") can return *thousands* of OSM elements from Overpass — confirmed live,
  2,595 elements, 1,285 with a website tag. `mapElementToProspect` checks each tagged website, and
  doing that one at a time (even with the timeout fix) made a single run take 20+ minutes. Fixed
  with bounded concurrent batching.
- `src/common/async/map-in-batches.ts` (new, with `map-in-batches.test.ts`) — extracted shared
  `mapInBatches(items, batchSize, mapItem, onBatchComplete?)` helper after the identical
  "unbounded `Promise.all` over a network call" shape caused *two* separate problems: Overpass's
  element-mapping loop (`ELEMENT_MAPPING_CONCURRENCY = 10` in `overpass.source.ts`) **and**
  `discovery.service.ts`'s enrichment chain, which was *also* firing a fully unbounded
  `Promise.all` across every discovered prospect in one run (2,598 simultaneous fetches in one
  observed run) — `ENRICHMENT_CONCURRENCY = 10` in `discovery.service.ts`.
- Granular progress: `runOverpassSource` and the enrichment loop now report per-batch progress
  (`"checked X/Y element(s)..."`, `"enriched X/Y"`) through the same `onProgress` callback chain
  the streaming console (below) consumes, instead of one long silent gap.

### 5. Companies House source was silently broken
Found while the user was pasting live console output. The Zod schema required a `company_name`
field the real search API (`api.company-information.service.gov.uk/search/companies`) never
actually returns — it returns `title` (`company_name` belongs to a *different* Companies House
endpoint, the per-company profile GET). Every real search failed validation and the source
reported itself "unavailable" on *every* call, even with a valid key. Fixed the field name in
`src/features/discovery/sources/companies-house.source.ts`, verified live against the real API
(confirmed working — got 4 real UK companies back). Test fixtures updated (`company_name` →
`title`), plus a new regression test using a real captured API response shape.

Texas Comptroller's `"search term matched too many entities - use a narrower category term"`
message is **intentional**, not a bug — the API itself rejects (413) overly-broad name searches;
this surfaces that distinctly from a generic outage. Nothing to fix there.

### 6. Live streaming console on `/discovery`
`POST /api/pipeline/discover` now streams newline-delimited JSON instead of returning one JSON
blob at the end, so the dashboard can show real-time progress instead of a blank spinner.
- `discovery.service.ts` — `runDiscovery` takes an optional 4th param, `onProgress?:
  DiscoveryProgressReporter` (`{ level: 'info'|'success'|'warn', message: string }`), called at
  every meaningful checkpoint: run start, each source's start/outcome, each enricher's
  start/outcome (+ per-batch), dedup, and each individual prospect persist (`Inserted: X`,
  `Updated: X`, `Skipped (do-not-contact): X`), plus a final `Done: ...` summary line. Both cron
  routes omit it — zero behavior change for them.
- `discovery.types.ts` — `discoveryProgressEventSchema`, `discoveryStreamLineSchema` (discriminated
  union: `progress` | `summary` | `error`) — client-safe mirrors, same pattern as
  `discoveryRunSummarySchema`.
- `app/api/pipeline/discover/route.ts` — rewritten to return a raw `Response` wrapping a
  `ReadableStream`, writing one JSON line + `\n` per event. `maxDuration = 60`.
- `discovery-trigger-form.tsx` — reads the stream via `response.body.getReader()`, appends each
  `progress` line to a `consoleLines` state array rendered in a dark, monospace, auto-scrolling
  **Console** card (color-coded by level: info=neutral, success=green, warn=amber) right below the
  "Run discovery" button. Persists after the dialog/run completes so the log stays reviewable;
  clears on the next run.
- Verified live multiple times against the real dev server, including a full real Yellow Pages
  scrape (36 found → 25 after dedup → 24 inserted, 1 updated) streamed correctly end-to-end.

### 7. `/prospects` — "Reason contains" filter
Free-text, case-insensitive substring filter against `signal.description` (the "Reason" half of
the "Signal : Reason" column) — a Postgres JSON-path `string_contains` filter, same pattern
already used for `signalType`/`signalStrength`.
- `prospects.repository.ts` — `ListProspectsFilters.reason?: string`, filter logic in `buildWhere`.
- `app/api/prospects/route.ts` — `reason` query param.
- `prospects-table.tsx` — new "Reason contains" text `Input` next to the Signal type/strength
  filters (no debounce — matches this component's existing convention for `priorityScoreMin/Max`,
  which also refetch on every keystroke).
- Verified live: `reason=no+website` correctly matched only prospects whose signal description
  contains that phrase, case-insensitively.

## Files modified this session (full list, with why)

See the "Everything already implemented" section above for the *why* on each — this is just the
flat list for quick scanning. All are on `main` already (commit `4a52b1b`) **except** the last one.

```
CLAUDE.md                                              — session notes appended (multiple times)
app/api/pipeline/discover/route.ts                     — NDJSON streaming rewrite
app/api/pipeline/discover/route.test.ts                — rewritten for streaming
app/api/prospects/route.ts                              — + reason query param
components/theme-provider.tsx                           — event.key undefined crash guard
next.config.ts                                          — serverExternalPackages
package.json / package-lock.json                        — playwright-core, @sparticuz/chromium, engines
src/common/async/map-in-batches.ts (new)                 — shared bounded-concurrency batching helper
src/common/async/map-in-batches.test.ts (new)
src/common/net/is-safe-fetch-target.ts                   — fetchSafely timeout + try/catch fix
src/common/net/is-safe-fetch-target.test.ts              — regression tests for the above
src/common/scraping/browser.ts                           — @sparticuz/chromium on serverless
src/common/scraping/browser.test.ts (new)
src/features/discovery/discovery-trigger-form.tsx        — streaming console UI
src/features/discovery/discovery.service.ts              — onProgress threading, batched enrichment
src/features/discovery/discovery.service.test.ts         — onProgress test coverage
src/features/discovery/discovery.types.ts                — stream-line schemas
src/features/discovery/sources/companies-house.source.ts — title vs company_name fix
src/features/discovery/sources/companies-house.source.test.ts
src/features/discovery/sources/geocode-nominatim.ts      — fetch timeout
src/features/discovery/sources/overpass.source.ts        — fetch timeout + batched element mapping
src/features/discovery/sources/overpass.source.test.ts
src/features/discovery/sources/yellowpages.source.ts     — playwright -> playwright-core type import
src/features/prospects/prospects.repository.ts           — reason filter
src/features/prospects/prospects.repository.test.ts      — reason filter tests (destructive-guarded, not run live)
src/features/prospects/prospects-table.tsx               — reason filter UI + (UNCOMMITTED) last-opened highlight
```

Not modified by me this session but changed on `main` by someone else (observed via file-change
notices, not authored by this session — see "Important architectural decisions"):
`app/api/login/route.ts`, `app/api/cron/seed-users/route.ts`, `app/login/page.tsx`,
`src/common/auth/password-hash.ts` (added `MIN_PASSWORD_LENGTH` export),
`src/common/auth/login-lockout.ts` (new file, not written by this session).

## Bugs fixed (this session)

1. **`event.key.toLowerCase()` crash** in `components/theme-provider.tsx`'s dark-mode hotkey
   listener — `event.key` can be `undefined` on synthetic keydown events (a password manager
   extension on the login page was the likely trigger). Fixed with a null guard.
2. **Playwright/Chromium missing on Vercel** — see "Playwright-on-Vercel fix" above.
3. **`fetchSafely()` could hang forever** — no fetch timeout, no error handling around its own
   `fetch()` call. The actual root cause of the "stuck on overpass: running…" report. See above.
4. **Overpass/Nominatim fetches also had no timeout** — same class of bug, fixed alongside #3.
5. **Unbounded concurrency in two places** — Overpass's element-mapping loop (sequential, too
   slow) and `discovery.service.ts`'s enrichment chain (`Promise.all` with no cap, too parallel —
   2,598 simultaneous fetches in one observed run). Both fixed via the new `mapInBatches` helper.
6. **Companies House source silently broken on every call** — wrong field name in the Zod schema
   (`company_name` vs the real `title`). See above.
7. **Prod DB schema drift** (earlier in the session, before the two-account-auth work): a
   collaborator had applied 3 Prospect columns (`address`, `phone`, `corroboratingSourceCount`)
   directly to the shared Neon database via local `prisma migrate dev`, without ever committing
   the migration files. Reconciled without touching any data (`prisma migrate resolve`
   bookkeeping only) — fully resolved once `origin/main` later got the real, properly-committed
   migrations from a teammate's PR; my own hand-reconstructed placeholder versions were discarded
   in favor of the real ones during a rebase.
8. **My own smoke-testing mistake, self-corrected**: while testing the new login flow live, I set
   a real throwaway password ("correct-horse-battery-staple") on the actual `Noel` account in
   production. Caught it and deleted the test `User` rows immediately after, restoring a clean
   first-login state before the user ever tried to log in for real. Mentioned here so a future
   session doesn't repeat it — **never smoke-test destructive/state-setting auth flows against
   the shared prod DB without cleaning up immediately after.**

## Current bugs / problems (UNRESOLVED)

1. **"Last opened prospect" row highlight — user reports still not seeing it, even after a hard
   refresh instruction.** This is the one uncommitted file. Status:
   - First attempt used `bg-accent/50` — root-caused as genuinely invisible (this theme's
     `--accent` is `oklch(0.963...)`, nearly identical to the `oklch(1...)` white background).
     Switched to `bg-primary/10 hover:bg-primary/15` (the same blue already used for links/the
     unseen-dot elsewhere in this table) — real contrast, confirmed present in both the compiled
     JS bundle (`lastOpenedProspectId` found in the live `_next/static/chunks/` output) and the
     compiled CSS (`bg-primary\/10`, `bg-primary\/15` both present) via direct verification against
     the running dev server.
   - Server-side code is confirmed 100% correct and being served correctly. The user's last report
     ("nope i dont see any visual effects") came *before* being told to hard-refresh; no
     confirmation yet on whether the hard refresh fixed it.
   - **Next session: ask the user directly whether the hard refresh worked before touching this
     code again.** If it's still not visible after a genuine hard refresh / fresh incognito tab,
     the bug is somewhere I haven't found yet — don't assume it's still the contrast issue.
2. **Vercel Cron may have never actually fired, ever.** Checked the DB for any `DiscoveryRun` row
   with `geography = 'New York, NY'` exactly (the literal string the cron's `GET` handler always
   uses) — zero, across the 9+ days `vercel.json` has existed on `main`. The user confirmed at
   least one successful Vercel deployment exists, which rules out "never deployed at all," but we
   got no further — the user said **"forget it"** mid-investigation and pivoted to a different
   feature. **This is still open and worth revisiting** if cron-driven automation matters:
   likely culprits are (a) the deployment isn't actually from the `main`/Production branch (Vercel
   only registers cron from Production deploys), or (b) `CRON_SECRET` isn't actually set correctly
   in Vercel's env vars. Neither was confirmed or ruled out.
3. **No `SENDING_DOMAIN` configured** — real cold-outreach sending is still capped/blocked. Confirmed
   the Resend API key itself works (got a real, structured response), but the Resend account is
   registered under a *different* email (`yassine.krichen@insat.ucar.tn`, the collaborator's),
   not the user's — sandbox mode only allows test sends to that address. No domain has been
   purchased yet; last discussion was brainstorming a `.tech` domain name and never landed on a
   final choice (moved from generic buzzword-compound names, which the user said "sound like
   phishing," to considering personal-name-based or single-real-word options — no decision made).

## Important architectural decisions

- **Session tokens never expire, by explicit user instruction** (not an oversight — this was an
  intentional, discussed tradeoff). Only logout or rotating `SESSION_SECRET` ends a session.
- **Exactly two accounts, ever, no public registration.** `KNOWN_USERNAMES` in
  `known-usernames.ts` is the single source of truth; the login route rejects any other nickname
  without even querying the database.
- **Someone else (not this session) hardened the auth system further after I built it**, and I
  should treat that as the current, correct state — not something to revert or "fix back":
  - Removed the "first login with a null password claims the account" flow entirely (a real
    race-condition vulnerability I'd built in — accounts must now be created *with* a password
    already set, via `seed-users`'s required `passwords` body).
  - Added `src/common/auth/login-lockout.ts` (5 failed attempts → 15 min lockout per nickname).
  - Bumped Next.js to 16.3.2 to close a Turbopack auth-bypass CVE.
  - Simplified `app/login/page.tsx` accordingly (no more needsSetup/confirm-password two-step,
    since accounts can no longer exist passwordless).
  **Do not re-introduce the old null-password-then-claim flow or a two-step signup UI** — it was
  deliberately removed as a security fix, not lost/regressed.
- **Bounded concurrency (10) is now the standard pattern for "map an array through a network
  call" in this codebase** — see `mapInBatches`. If you're about to write `await
  Promise.all(items.map(asyncFn))` anywhere in discovery/enrichment code, check whether `items`
  can plausibly be large (hundreds+) first; if so, use `mapInBatches` instead.
- **`fetchSafely()` now guarantees it never throws and never hangs** — every caller can rely on
  it degrading to `null` on any failure, including a timeout. Don't add a defensive try/catch
  around calls to it "just in case" — that's now redundant with what the function itself already
  guarantees.
- **Vercel Hobby plan constraints shaped the cron design**: 2 consolidated cron jobs instead of
  one per pipeline stage, because Hobby caps Cron Jobs at roughly once/day each. If the project
  ever moves to Vercel Pro, the per-stage cron routes still exist and work (`POST` +
  `x-cron-secret`) — `vercel.json` would just need more entries and 3 more `GET` handlers (only
  `discover` and `daily` have one today).

## Commands / configuration changes

- `package.json`: added `"engines": { "node": ">=22.17.0" }`; `playwright` moved from
  `dependencies` to `devDependencies`; added `playwright-core`, `@sparticuz/chromium` as real
  dependencies.
- **Local machine setup needed after pulling this branch**: `npm install`, then
  `npx playwright install chromium` (the version pin changed, the old locally-cached browser
  binary was invalidated).
- `next.config.ts`: added `serverExternalPackages: ["@sparticuz/chromium", "playwright-core"]`.
- `vercel.json` (new file): the 2 cron entries described above.
- No new migrations pending — `npx prisma migrate status` reports "Database schema is up to date"
  against the current `DATABASE_URL` as of this write.
- **Vercel dashboard action still needed** (unconfirmed whether it's been done):
  `CRON_SECRET` must be set in Vercel's Project → Settings → Environment Variables (same value as
  local `.env`) for the cron `GET` handlers' Bearer auth to ever succeed. Also confirm Node.js
  Version is 22.x+ there for `@sparticuz/chromium`.

## Tests run and their results

- `npx tsc --noEmit -p tsconfig.json` — clean (0 errors) as of the last check this session.
- `npx eslint .` — clean (0 errors); only the two known, pre-existing, unrelated
  `react-hooks/incompatible-library` warnings on `useReactTable()` calls in `clients-table.tsx`
  and `prospects-table.tsx` (TanStack Table's own API shape, not fixable here, not a regression).
- Full non-destructive suite (`npx vitest run` excluding the 7 destructive-guarded integration
  files): **102 test files, 978 tests, all passing** as of the final check this session.
- The 7 destructive-guarded files (`*.repository.test.ts`,
  `discovery.service.dnc-preservation.test.ts`, `bridge-budget.test.ts`, `hunter.source.test.ts`,
  `daily-send-counter.test.ts`, `followup-scheduler.cap-integration.test.ts`,
  `retention-scheduler.cap-integration.test.ts`) were **not run** this session (per standing
  policy — they truncate real tables and need `CONFIRM_DESTRUCTIVE_TESTS=true` +
  `TEST_DATABASE_URL`, which is now actually configured in `.env` but was never deliberately
  exercised). The 2 new tests added to `prospects.repository.test.ts` (the `reason` filter) were
  verified correct by code review + a live API smoke test instead, not by actually running that
  file.
- Extensive live smoke-testing against the real dev server throughout (not just unit tests):
  real Yellow Pages scrape (25 real Austin prospects inserted), real Overpass NYC run (confirmed
  progress to 2,380/2,594 elements before a background-process kill, no hang), real Companies
  House call (4 real UK companies), real login flow (first-login password setup, wrong password,
  lockout path implicitly), real `reason` filter query.
- `npx next build` — succeeded (used to verify the Playwright/Vercel bundling fix doesn't break
  the production build locally).

## What remains to be done

1. Confirm the last-opened-prospect highlight actually renders after a hard refresh (see "Current
   bugs" #1) — this is a direct open loop with the user, answer it first.
2. Commit + push the `prospects-table.tsx` highlight feature once confirmed working.
3. Resolve whether Vercel Cron has ever actually fired (see "Current bugs" #2) — check Production
   branch setting and `CRON_SECRET` in Vercel's dashboard; the user explicitly deferred this, not
   declined it.
4. Buy a domain and configure `SENDING_DOMAIN` + verify SPF/DKIM/DMARC in Resend before any real
   cold-outreach volume can go out (`DOMAIN_DNS_VERIFIED` stays `false`, sends stay capped at
   `DAILY_SEND_CAP_TEST` — 3/day — until then). No domain name was finalized.
5. Verify the Playwright/`@sparticuz/chromium` fix actually works on a real Vercel deployment
   (can't be tested locally — Linux-only binary). Trigger a real discovery run with
   Yellow Pages/Indie Hackers enabled on the deployed URL and check Vercel's function logs.
6. Consider whether `mapInBatches`' concurrency of 10 needs tuning based on real-world Overpass
   run times once verified on Vercel (serverless functions have less headroom than local dev).

## The exact next steps

1. Ask the user: "did the hard refresh fix the highlight?" — don't just assume and re-code.
2. If yes: `git add src/features/prospects/prospects-table.tsx`, commit (with a message describing
   the last-opened-prospect highlight feature), push to `main` (only if the user says
   commit/push — don't assume from silence).
3. If no: re-open the investigation. The server-side code is verified correct, so look at
   something not yet checked — e.g. whether the `Dialog`'s close handler or some other effect is
   somehow resetting `lastOpenedProspectId`, or a browser extension/adblocker interfering, or
   ask the user to open dev tools and check the element's actual computed class list.
4. Then pick up item 3 or 4 from "What remains to be done" — probably the Vercel Cron
   investigation, since it's a fully self-contained diagnostic task with a clear next action
   (check two specific Vercel dashboard settings) and was explicitly deferred, not abandoned.

## Things you should NOT redo

- **Do not** rebuild the "first login sets password" / null-password-claim flow. It was
  deliberately removed as a security fix by someone else after I originally built it. The current
  `seed-users` route requires passwords up front; that's correct, current behavior.
- **Do not** add an age/expiry check to `verifySessionToken` or shorten the cookie lifetime — the
  non-expiring session is a deliberate, explicit product decision, not a bug.
- **Do not** re-run `prisma migrate dev` against the shared `DATABASE_URL` without first checking
  `prisma migrate status` for drift — this session hit real prod-DB drift once already (see "Bugs
  fixed" #7) caused by exactly that pattern. Prefer `prisma migrate deploy` for applying already-
  authored migrations to the shared DB.
- **Do not** re-seed or reset the `Noel`/`EvilWithin` accounts' passwords — they're real, currently
  in use by the user for testing. If you need to smoke-test the login flow again, mint a session
  token directly via the app's own HMAC signing (same `SESSION_SECRET`) rather than logging in
  through the real form, and never touch `passwordHash` on an existing account.
- **Do not** re-introduce an unbounded `Promise.all(items.map(asyncFn))` over network calls in
  discovery/enrichment code — use `mapInBatches`. Two separate bugs already came from this exact
  pattern this session.
- **Do not** assume `bg-accent/*` utilities are visible in this theme for anything meant to stand
  out — `--accent` is nearly white in light mode. Use `bg-primary/*` (or check the actual OKLCH
  values in `app/globals.css` first) for anything that needs real contrast.
- **Do not** run any of the 7 destructive-guarded test files without deliberately setting
  `CONFIRM_DESTRUCTIVE_TESTS=true` and being certain `TEST_DATABASE_URL` (now configured) is
  genuinely a separate branch from `DATABASE_URL` — the guard checks this, but don't rely on the
  guard as your only line of defense; think before running them.
- **Do not** re-litigate the Companies House `title` vs `company_name` fix — it's verified correct
  against a real, live API response captured in this session (also embedded as a regression test).


## Automatic Progress Handoff

Maintain a persistent project handoff file at:

`.claude/handoff.md`

The handoff is for preserving important project state across context compaction and new Claude Code sessions.

### When to update it

Automatically update `.claude/handoff.md when:

* Context usage approaches ~50%.
* A major feature or task is completed.
* An important architectural decision is made.
* A significant bug is discovered or fixed.
* Before performing `/compact`.
* Before ending a session when meaningful work has been done.

Do not update it for trivial changes.

### What to preserve

Keep the handoff concise and actionable.

Include only:

1. Current objective
2. Current implementation status
3. Important decisions and requirements
4. Files/components significantly changed
5. Bugs/issues discovered
6. Tests and verification results
7. Playwright verification results when relevant
8. Current blockers
9. Exact next steps
10. Important commands/configuration needed to continue

Do NOT copy the conversation into the handoff.

Do NOT include routine command output, verbose explanations, or information that can easily be rediscovered from the code.

### Updating the handoff

When updating it:

* Read the existing handoff first.
* Preserve still-relevant information.
* Remove obsolete information.
* Merge new progress into the existing state.
* Keep it compact.
* Never replace useful existing information with vague statements.

The handoff must describe the project's CURRENT state, not the history of every action.

### Context preservation

When context reaches approximately 50%, update the handoff BEFORE continuing with large additional work.

If context is approaching compaction, make sure the handoff is up to date before compacting.

After compaction or when starting a new session, read `.claude/handoff.md` before continuing work.

## Chrome DevTools

Use Chrome DevTools when browser debugging requires information that Playwright alone does not provide, especially:

* JavaScript console errors
* failed network requests
* HTTP status codes
* API request/response debugging
* browser runtime errors
* performance investigation

Do not invoke Chrome DevTools unnecessarily for simple UI verification.

Prefer Playwright CLI for normal frontend verification.

When inspecting console or network data, retrieve only the relevant errors/requests. Do not dump the entire console history or all network requests into context.
