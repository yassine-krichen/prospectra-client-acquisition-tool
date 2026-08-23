# Biz Scraper - project context

Read this first in any new session on this repo. Written 2026-08-05 to survive a context clear.

**On branch `feat/discovery-engine-v2`?** Read `docs/discovery-engine-roadmap.md` first - it has
the full discovery-engine vision and exactly what this branch is (and isn't) building.

## What this is

Cold-outreach pipeline for a solo dev/agency operator: discover companies whose own public
surface reveals technical debt (no HTTPS, stale stack, funding event, hiring post the company
can't yet support) → enrich contact info → AI-draft outreach (3 framework variants) → human
approves in a queue → send via Resend → 4-touch follow-up if no reply → convert replied/won
prospect to a paying Client with Jobs → retention touches on delivered/active Jobs.

Single-operator app - dashboard sits behind one shared password by design, not multi-tenant.

Stack: Next.js 16 (App Router, Turbopack), TypeScript strict, Prisma 7 + Postgres, Zod, Vitest,
TanStack Table, Tailwind (shadcn primitives - as of the pro-UI redesign: button, input, select,
table, badge, card, checkbox, dialog, progress, tabs, separator, skeleton, sonner (toasts). Added
deliberately for a richer/more "product" feeling dashboard - reuse these before reaching for a new
one, and prefer `npx shadcn add <name>` over hand-rolling a component this registry already has).

## Current git state

- Active branch: `feat/phase6-8-pricing-clients-retention` - this is the up-to-date branch, NOT
  `main` (main is several phases behind; only merge/rebase into main deliberately, don't assume
  main is current).
- 5 commits ahead of `origin/feat/phase6-8-pricing-clients-retention`, not pushed.
- Working tree clean as of last commit `c792420`.
- `git log --oneline` tells the real phase history if you need it - don't re-derive it here.

## How to run it

The database moved off local Docker Postgres onto Neon (hosted Postgres) - `docker-compose.yml` is
deleted, and there's no local DB to start. `./setup.ps1` from repo root (PowerShell) does the rest:
checks Node/npm, creates `.env` from `.env.example` with generated secrets if missing, `npm install`,
`npx prisma generate`, migrates the DB (`DATABASE_URL`), runs the full test suite. **You must create
the Neon database yourself first** (free project at https://neon.tech) and paste its connection
string into `.env` before running the script - it has no way to provision it for you. The app's
`DATABASE_URL` and the test suite's `TEST_DATABASE_URL` are separate Neon branches - see the Testing
section below for what that means for `npm test` and for setting up `TEST_DATABASE_URL`.

Then `npm run dev`, open `http://localhost:3000`. Auth is no longer a shared env-var password - see
the Auth section below; the short version is: `POST /api/cron/seed-users` once (with
`x-cron-secret`) to provision the two accounts, then log in as one of them at `/login` and set its
password on first use.

**Known issue**: the Turbopack dev server OOMs and auto-restarts/crashes periodically during long
sessions (`Server is approaching the used memory threshold, restarting...`, eventually exits with
code 134/SIGABRT). Not investigated further - just restart `npm run dev` when it dies. Don't spend
time chasing this unless it starts blocking real work.

## Env vars - what's actually configured right now

Real, working keys already in `.env` (don't need touching): `DATABASE_URL`,
`SESSION_SECRET`, `CRON_SECRET`, `GOOGLE_PLACES_API_KEY` (key set but **billing not enabled** on
the Google Cloud project - discovery reports `REQUEST_DENIED` for this source specifically, low
priority fix, everything else degrades around it fine), `BUILTWITH_API_KEY`,
`PRODUCT_HUNT_API_TOKEN`, `GITHUB_TOKEN`, `HUNTER_API_KEY`, `PEOPLE_DATA_LABS_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY`, `RESEND_API_KEY`.

`DEEPSEEK_API_KEY` is no longer in active use (2026-08-23) - DeepSeek was dropped from the
drafting rotation in `model-rotation.ts` (the one provider in the pool with no enforced cost cap,
judged not worth it). The `ModelUsed` Prisma enum still has `deepseek` and historical `Draft` rows
still reference it - that's untouched, this only stops NEW drafts from selecting it.

Deliberately still empty (all optional, all degrade gracefully by design - see `.env.example`'s
comments for exactly what each does):
- `CRUNCHBASE_API_KEY` - paid, correctly deferred until there's revenue.
- `CLAUDE_BRIDGE_URL` / `CLAUDE_BRIDGE_API_KEY` - only needed if running the local
  claude-web-bridge sibling app for the humanizer overflow tier.
- `SENDING_DOMAIN` - no domain owned yet. GitHub Student Pack → free Namecheap `.me` domain is a
  viable path.
- `DOMAIN_DNS_VERIFIED` - hard gate on real send volume (`domain-verification-gate.ts`), only flip
  to exact string `"true"` after SPF/DKIM/DMARC are genuinely verified in Resend. Until then sends
  stay capped at `DAILY_SEND_CAP_TEST` (3/day).
- `DOMAIN_WARMUP_START_DATE` - set once DNS is verified, feeds the post-verification ramp schedule.
- `RESEND_WEBHOOK_SECRET` - needed once a Resend inbound webhook is actually configured pointing at
  `/api/webhooks/resend`; until then that route fails closed (rejects all events, correct behavior).

## Architecture

Feature-based folders under `src/features/<feature>/`: `discovery`, `enrichment`, `drafting`,
`sending`, `followups`, `retention`, `matching`, `pricing`, `clients`, `prospects`, `navigation`,
`pipeline`. Controller (route handler) → Service → Prisma. `app/api/**/route.ts` are thin;
business logic lives in `*.service.ts`.

**Prisma models**: `Prospect`, `Draft`, `ApiUsageCounter`, `BridgeCooldown`, `Client`, `Job`, `User`.
Full enum/model list is in `prisma/schema.prisma` - read it directly rather than trusting a summary
here if you need exact fields, this doc will drift.

**Auth (rewritten 2026-08-21, hardened 2026-08-23 - two fixed accounts, no shared password)**:
`proxy.ts` at repo root is the one session gate - deny-by-default for everything except `login`,
`api/login`, `api/webhooks/resend`, and `api/cron/*` (those last two verify their own
signature/secret instead of a session, since their callers - Resend, a cron scheduler - never have
a browser session cookie).

There is no `DASHBOARD_PASSWORD` anymore and no public registration. Exactly two accounts will ever
exist - `Noel` and `EvilWithin` (`src/features/auth/known-usernames.ts`, `KNOWN_USERNAMES` - the one
place their nicknames are defined; login rejects any other nickname without even querying the DB).
Both are provisioned by calling `POST /api/cron/seed-users` (`x-cron-secret` auth, same pattern as
the other cron routes) - idempotent, never overwrites an existing row, but now **requires** a
password in the request body (`{ passwords: { Noel: '...', EvilWithin: '...' } }`, min 8 chars,
hashed via `password-hash.ts` before storage) to create any not-yet-existing account. A nickname
missing a valid password in the call is skipped with a per-nickname error result rather than being
created with a null password - this route is the *only* way an account is ever provisioned, and it
never again produces a claimable unclaimed account.

`app/api/login/route.ts` is password-check-only - `verifyPassword` against the looked-up
`User.passwordHash`, hashed via `src/common/auth/password-hash.ts` (Node's built-in `scrypt`, no new
dependency, same "hand-roll the crypto" convention as `session.ts`'s HMAC signing). A null
`passwordHash` (shouldn't occur post-hardening, but handled defensively) fails closed with the exact
same generic 401 as every other rejection. On success, stamps `lastLogin*` (`Ip/UserAgent/Device/
Browser`, via `src/common/auth/request-metadata.ts`'s `getClientIp()`/`parseUserAgent()` - no new
dependency for either). Wrong nickname / wrong password / unprovisioned nickname / locked-out
nickname all return generically (401, or 429 for lockout) - never confirms which nicknames exist.

**Login lockout (added 2026-08-23)**: `src/common/auth/login-lockout.ts` (`LoginLockout` Prisma
model, mirrors `BridgeCooldown`'s shape) - 5 failed attempts locks that nickname out for 15 minutes,
checked *before* the password comparison so a locked-out attempt never even reaches `verifyPassword`.
Fails closed on any DB error (treats as locked, same posture as `bridge-budget.ts`'s
`isBridgeInCooldown`). Keyed by nickname only, not IP - both nicknames are already public (shipped
to the client bundle for the login picker), and this is a 2-person internal tool, so the accepted
tradeoff is that an attacker who knows a nickname could deliberately lock out its real owner; judged
acceptable at this app's actual threat model, not an oversight.

**Removed 2026-08-23**: the previous "first login sets password" flow (a null `passwordHash` meant
whoever submitted a password first permanently claimed that account, no verification) and its
`GET /api/login/status?nickname=` oracle endpoint were both a real vulnerability, not documented
design to preserve - a security audit found the race and the enumeration risk, and both were deleted
outright rather than hardened in place. If you're reading old context (a summary, a stale branch)
that describes either of these as current behavior, it's describing the bug that got fixed, not the
current system.

**Session tokens are deliberately non-expiring** - the user's explicit call, not an oversight.
`src/common/auth/session.ts`'s `verifySessionToken` has no age check at all; a token is valid until
`SESSION_SECRET` changes or the cookie is cleared (logout). The token itself now carries
`userId.nickname.issuedAt.signature` (was just `issuedAt.signature` under the old single-password
scheme) so `proxy.ts` and `app/(dashboard)/layout.tsx` can identify *which* account is logged in
without a DB call. The cookie's `Max-Age` is `SESSION_COOKIE_MAX_AGE_SECONDS` (400 days) purely
because Chrome hard-caps cookie lifetime there regardless of what's set - not a server-side
expiry, logging in again just resets that clock. `app/(dashboard)/layout.tsx` (a server component)
reads the cookie directly to pass the signed-in nickname down to `UserMenu`'s sidebar greeting -
safe specifically because that file is a server component, not a `'use client'` one (see the
client-bundle warning below).

**Two auth patterns for triggering pipeline stages** - don't confuse them:
1. `app/api/cron/{discover,draft-batch,followups,retention}/route.ts` - `POST` accepts the
   `x-cron-secret` header (`env.CRON_SECRET`) for manual/ad-hoc triggering (curl, one-off backfills).
   `discover` and `daily` also have a `GET` handler authenticated via `Authorization: Bearer
   <CRON_SECRET>` instead - that's Vercel's own Cron Jobs convention (GET-only, auto-attaches that
   header from the project's `CRON_SECRET` env var), and is what `vercel.json` actually points at.
   Shared auth helpers live in `src/common/auth/cron-auth.ts`
   (`isAuthorizedByCronHeader`/`isAuthorizedByCronBearer`) - don't duplicate the check inline again.
2. `app/api/pipeline/{discover,draft-batch,followups,retention}/route.ts` - session-gated only (no
   cron-secret check, proxy.ts handles auth), call the exact same service functions directly. These
   are what the dashboard UI's Discovery and Pipeline pages actually call. Don't add a cron-secret
   check to these or have the browser send the secret - that was a deliberate design choice to keep
   the browser from ever handling that secret.

## Automated cron (`vercel.json`, added 2026-08-21)

Vercel's Hobby plan (what this project is on) caps Cron Jobs to a small fixed count and once-a-day
frequency - not the "every 6 hours" originally floated - so two daily jobs cover everything instead
of one per pipeline stage:
- `GET /api/cron/discover` (12:00 UTC) - cycles through a fixed New York category list
  (`src/features/discovery/ny-target-categories.ts`, `NY_TARGET_CATEGORIES`/`pickDailyCategory`),
  deterministically by UTC calendar date (no persisted "last run" pointer - stateless by design for
  a serverless cron). Categories are deliberately upscale/professional-services only (law firms,
  dental practices, real estate agencies, etc.) - low-budget categories were excluded on purpose, a
  business call, not an oversight. Runs `branch: 'both'` since Branch B sources ignore geography
  anyway. `maxDuration = 60` (scraper sources can be slow with retry-with-backoff).
- `GET /api/cron/daily` (14:00 UTC, new route) - runs drafting → follow-ups → retention back to
  back in one invocation (`draftBatch`, `humanizeBatch`, `runFollowupScheduler`,
  `runRetentionScheduler`), consolidated onto one route specifically to fit inside the 2-cron-job
  Hobby cap. Each stage is independently batch-size-bounded and follow-ups/retention re-check the
  daily send cap themselves, so chaining them is safe. `maxDuration = 60`. `draftBatch`/
  `humanizeBatch` are called here with `{ signalStrength: 'strong' }` (`DraftBatchOptions` in
  `drafting.service.ts`) - this fully-unattended path only auto-drafts/humanizes `strong` ("High")
  signal prospects, leaving medium/weak-signal ones for a human to draft manually from the
  dashboard's Pipeline page if they judge it worthwhile. Manual triggering (Pipeline page,
  `POST /api/cron/draft-batch`) omits the option and is unrestricted, unchanged from before.

Enrichment has deliberately **no** cron - newly discovered prospects sit at `new` status until a
human enriches them from `/prospects` (avoids burning paid Hunter/PeopleDataLabs quota on
low-quality/spam discoveries before a human's had a look - see the Recommended Action column, which
flags likely-spam domains as "Ignore").

If moving to Vercel Pro later (unlocks arbitrary cron frequency/count): the per-stage cron routes
still exist and work unchanged (`discover`, `draft-batch`, `followups`, `retention`, each with their
own `POST`/`x-cron-secret` path) - `vercel.json` would just need separate entries pointed at them
instead of (or alongside) the consolidated `daily` route, and `draft-batch`/`followups`/`retention`
would each need their own `GET` handler added (only `discover` and `daily` have one today, since
those are the two `vercel.json` actually calls).

## Session 2026-08-21 changes: dashboard polish & reliability

**Discovery sources registry** (`src/features/discovery/discovery-source-registry.ts`): Single source
of truth for which discovery sources exist, metadata (displayName, paid/free, required env var,
branch assignment, known issues), used by both `discovery.service.ts` (server orchestration) and
`discovery-trigger-form.tsx` (source checklist UI). Replaces hand-duplicated source metadata that
was scattered across multiple files.

**Discovery history**: New `GET /api/discovery/runs` endpoint returns past discovery runs. UI shows
history below the discovery form (most recent first), highlights when a duplicate search already
exists (same category/geography/branch).

**Queue 3-variant rework**: The approval queue now displays all generated draft variants per prospect
side-by-side (radio-button selection between them). Approval submits whichever variant is currently
highlighted. Drafts can still be edited inline before approval. Bulk-approve via prospect checkboxes.

**Bulk prospect actions**: New `/api/prospects/bulk/{seen,enrich,draft,match,win}` endpoints for
row-level checkboxes in the prospects table. Checkbox state is client-side only (no persistence).

**Dead-letter tracking**: `Prospect.lastDraftFailure` (failed draft attempts) and `Draft.lastSendFailure`
(failed send attempts) now track the most recent failure for each, cleared on the next success.
Enables dashboard visibility into what failed and why, without swallowing the error.

**Auth UX**: Logout via `POST /api/auth/logout` (new endpoint). Theme toggle (light/dark/system) in
top-right menu via `next-themes`. Greeting in sidebar footer.

**Discovery reliability**: Added retry-with-backoff for scraper-based sources (Yellow Pages, Indie
Hackers) to handle transient network/selector failures. Fixed selector bugs in `indiehackers.source.ts`.

## The recurring bug class this session fixed 3 times - read this before touching any 'use client' file

`src/common/config/env.ts` validates server secrets (`DATABASE_URL`, `SESSION_SECRET`, etc.) at
**module import time** via a top-level `export const env = loadEnv()`. If any file that gets
imported - even transitively - by a `'use client'` component imports `env.ts`, the whole module
gets bundled into the browser JS. In the browser, `process.env` has none of those vars, so
`loadEnv()` throws on page load and crashes the page client-side (confirmed multiple times: the
page can still SSR fine - `curl` looked fine - but hydration crashes and the app becomes
unusable). This is NOT a cosmetic dev-overlay issue; it's a hard crash.

Fixed 3 times this session:
1. `service-catalog.ts` imports `env` (for `getHourlyRateCents()`). `prospect.types.ts` needed its
   `serviceTypeSchema`/`ServiceType` export but was importing it from `service-catalog.ts`, dragging
   `env` into the `prospects-table.tsx` client bundle. Fix: created
   `src/features/pricing/service-type.ts` as a pure, env-free home for just that schema/type;
   `service-catalog.ts` re-exports from there for backward compat.
2. `client.types.ts` had the exact same mistake (importing `ServiceType` from `service-catalog.ts`
   instead of `service-type.ts`) - caught in code review before it shipped, same fix applied.
3. `proxy.ts` didn't exempt `api/cron/*` from the session gate, so cron-secret-authenticated routes
   were unreachable (redirected to `/login`) by design intent's own real caller. Different bug,
   same session, same root habit of not tracing a boundary fully before shipping it.

**Rule going forward**: before adding an import to any `'use client'` file (or a file that file
imports, transitively), check the imported file doesn't import `@/common/config/env`,
`@/common/db/client`, `@/lib/generated/prisma`, or any `*.service.ts`/`*.repository.ts` file. Route
handlers (`app/api/**/route.ts`) are exempt from this concern - they're server-only regardless of
what they import, the hazard is specifically the client-component bundle.

## UI map (everything is now reachable - full buildout done 2026-08-05, polish pass 2026-08-21)

Sidebar nav (`src/features/navigation/dashboard-nav.tsx`, rendered by
`app/(dashboard)/layout.tsx`): Prospects / Queue / Clients / Discovery / Pipeline.

Top-right auth menu (`src/features/navigation/user-menu.tsx`): greeting + theme toggle (light/dark/system) +
logout button (`POST /api/auth/logout`).

- `/prospects` - table with filters, an Actions column (Enrich/Draft/Match/Win buttons per row,
  wired to `app/api/prospects/[id]/{enrich,draft,match,win}/route.ts` via
  `src/features/prospects/prospect-actions.ts`). Row-level bulk actions via checkboxes for seen/enrich/draft/match/win
  (`POST /api/prospects/bulk/{seen,enrich,draft,match,win}`).
- `/queue` - approval queue (`src/features/sending/approval-queue-table.tsx`). Each prospect now displays
  all generated draft variants side-by-side with radio buttons for selection; approval sends whichever
  variant is currently highlighted. Inline editing of draft bodies. Batch-approve via checkboxes. Only
  screen that can actually cause an email to send.
- `/clients` - list (`src/features/clients/clients-table.tsx`), links to detail.
- `/clients/[clientId]` - client info, Jobs table with activate/deliver buttons, create-Job form
  with a live price-range lookup (`GET /api/pricing/catalog?companySize=...`).
- `/discovery` - form to trigger discovery. Source checklist (Branch A/B selector, per-source checkboxes with
  Paid/Free and Configured/Not configured badges, known issues surfaced inline) backed by
  `src/features/discovery/discovery-source-registry.ts` as the single source of truth for source metadata.
  Per-run result summary below form. Discovery run history below that, most recent first, showing past
  searches that match the current category/geography/branch combination
  (via `GET /api/discovery/runs`). Calls `POST /api/pipeline/discover`.
- `/pipeline` - three buttons (draft-batch / follow-ups / retention), each with independent
  loading/result state. Calls `POST /api/pipeline/{draft-batch,followups,retention}`.

## Current data state

Not tracked in this file — drift is inevitable and fast. Check `/prospects` and `/clients` directly
in the dashboard. The database was wiped and rebuilt multiple times during the 2026-08-21 polish pass
(test-DB isolation fixes, discovery reliability improvements), so any prior counts are stale.

## Testing

`npm test -- --run` (Vitest). Convention: route handlers and services get colocated `*.test.ts`
files; React components do NOT get test files in this codebase (verified - no `.tsx` test files
exist anywhere) - don't add them unless the user asks or the convention changes.

**Database isolation (fixed 2026-08-21, after losing real data twice).** The app's `DATABASE_URL`
and the test suite's database are now two separate Neon branches - they used to be the same
database, and a routine `npx vitest run` silently wiped the Prospect/Client/Job/ApiUsageCounter
tables via table-wide `deleteMany()` calls in 7 integration test files, twice, before anyone
noticed. Those 7 files (discovery.service.dnc-preservation.test.ts, bridge-budget.test.ts,
hunter.source.test.ts, prospects.repository.test.ts, daily-send-counter.test.ts,
followup-scheduler.cap-integration.test.ts, retention-scheduler.cap-integration.test.ts) now hit
`TEST_DATABASE_URL` (a dedicated Neon branch, see `.env.example`) via
`src/common/testing/test-db-client.ts`, never `DATABASE_URL` - each file `vi.mock`s
`@/common/db/client` to redirect the production service code under test onto the test client too,
not just the test's own direct Prisma calls (`fileParallelism: false` in `vitest.config.ts` still
applies - these run sequentially, not racing each other).

Each of the 7 files calls `assertDestructiveTestsAllowed()`
(`src/common/testing/require-destructive-test-guard.ts`) in a `beforeAll`, which enforces three
independent conditions before letting the file proceed, each with its own error message: (1)
`CONFIRM_DESTRUCTIVE_TESTS=true` is set, (2) `TEST_DATABASE_URL` is actually configured, (3)
`TEST_DATABASE_URL` is not the same value as `DATABASE_URL` (refused regardless of the flag - the
direct guard against the exact mistake that caused both incidents). Plain `npm test` / `npx vitest
run` fails those 7 files loudly (skipping their tests, touching nothing) instead of silently
wiping data.

**Migrations must be applied to both databases going forward.** After running `npx prisma migrate
dev` (or any schema change) against the app's `DATABASE_URL`, also run `npm run db:migrate:test`
(`scripts/migrate-test-db.mjs`) to bring the isolated test branch's schema up to date before next
running the 7 files above - this is an ongoing step, not a one-time setup task.

`npm run typecheck` and `npx eslint .` should both be clean before committing anything.

## Working-style notes for this repo specifically

- Database is Neon (hosted Postgres), not local Docker - Docker is no longer part of this project at
  all (`docker-compose.yml` removed, `setup.ps1` no longer touches it). Two separate Neon branches
  in `.env` (never committed): `DATABASE_URL` for the app, `TEST_DATABASE_URL` for the 7
  destructive integration tests - see Testing above.
- User is caveman-mode-terse in chat but expects normal prose in code/commits/PRs (per their global
  CLAUDE.md).
- Delegation policy (user's global CLAUDE.md): planner before non-trivial features, plan approval
  gate (present plan, wait for explicit go-ahead) before implementer, full test loop
  (implementer → test-writer → test-runner → code-reviewer → committer) before anything gets
  committed. This was followed for the full-UI buildout and caught 2 real bugs in review before
  they shipped - worth continuing to follow for anything non-trivial, not just as box-checking.
