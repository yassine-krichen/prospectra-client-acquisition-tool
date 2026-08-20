# Backstop (biz-scraper) - project context

Read this first in any new session on this repo. Written 2026-08-05 to survive a context clear.

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
string into `.env` before running the script - it has no way to provision it for you. There's a
single database, shared by the app and the test suite - see the Testing section below on what that
means for `npm test`.

Then `npm run dev`, open `http://localhost:3000`, log in with `DASHBOARD_PASSWORD` from `.env`.

**Known issue**: the Turbopack dev server OOMs and auto-restarts/crashes periodically during long
sessions (`Server is approaching the used memory threshold, restarting...`, eventually exits with
code 134/SIGABRT). Not investigated further - just restart `npm run dev` when it dies. Don't spend
time chasing this unless it starts blocking real work.

## Env vars - what's actually configured right now

Real, working keys already in `.env` (don't need touching): `DATABASE_URL`, `DASHBOARD_PASSWORD`,
`SESSION_SECRET`, `CRON_SECRET`, `GOOGLE_PLACES_API_KEY` (key set but **billing not enabled** on
the Google Cloud project - discovery reports `REQUEST_DENIED` for this source specifically, low
priority fix, everything else degrades around it fine), `BUILTWITH_API_KEY`,
`PRODUCT_HUNT_API_TOKEN`, `GITHUB_TOKEN`, `HUNTER_API_KEY`, `PEOPLE_DATA_LABS_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `RESEND_API_KEY`.

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

**Prisma models**: `Prospect`, `Draft`, `ApiUsageCounter`, `BridgeCooldown`, `Client`, `Job`.
Full enum/model list is in `prisma/schema.prisma` - read it directly rather than trusting a summary
here if you need exact fields, this doc will drift.

**Auth**: `proxy.ts` at repo root is the one gate - deny-by-default, session cookie required for
everything except `login`, `api/login`, `api/webhooks/resend`, and `api/cron/*` (those last two
verify their own signature/secret instead of a session, since their callers - Resend, a cron
scheduler - never have a browser session cookie).

**Two auth patterns for triggering pipeline stages** - don't confuse them:
1. `app/api/cron/{discover,draft-batch,followups,retention}/route.ts` - authenticate via
   `x-cron-secret` header (`env.CRON_SECRET`), meant for an actual scheduler (none configured yet,
   no `vercel.json` cron schedule exists - everything is manually triggered today).
2. `app/api/pipeline/{discover,draft-batch,followups,retention}/route.ts` - session-gated only (no
   cron-secret check, proxy.ts handles auth), call the exact same service functions directly. These
   are what the dashboard UI's Discovery and Pipeline pages actually call. Don't add a cron-secret
   check to these or have the browser send the secret - that was a deliberate design choice to keep
   the browser from ever handling that secret.

## The recurring bug class this session fixed 3 times - read this before touching any 'use client' file

`src/common/config/env.ts` validates server secrets (`DATABASE_URL`, `DASHBOARD_PASSWORD`, etc.) at
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

## UI map (everything is now reachable - full buildout done 2026-08-05)

Sidebar nav (`src/features/navigation/dashboard-nav.tsx`, rendered by
`app/(dashboard)/layout.tsx`): Prospects / Queue / Clients / Discovery / Pipeline.

- `/prospects` - table with filters, an Actions column (Enrich/Draft/Match/Win buttons per row,
  wired to `app/api/prospects/[id]/{enrich,draft,match,win}/route.ts` via
  `src/features/prospects/prospect-actions.ts`).
- `/queue` - approval queue (`src/features/sending/approval-queue-table.tsx`), the only screen that
  can actually cause an email to send.
- `/clients` - list (`src/features/clients/clients-table.tsx`), links to detail.
- `/clients/[clientId]` - client info, Jobs table with activate/deliver buttons, create-Job form
  with a live price-range lookup (`GET /api/pricing/catalog?companySize=...`).
- `/discovery` - form to trigger discovery (category/geography/branch), shows per-source result
  summary. Calls `POST /api/pipeline/discover`.
- `/pipeline` - three buttons (draft-batch / follow-ups / retention), each with independent
  loading/result state. Calls `POST /api/pipeline/{draft-batch,followups,retention}`.

## Current data state (as of last check, 2026-08-05)

28 prospects discovered (branch `a`, category `plumber`, geography `Austin, TX`, via yellowpages -
Google Places failed on that run due to the billing issue above). 0 clients, 0 jobs - nothing's
been drafted/approved/won yet. This will obviously drift; check `/prospects` and `/clients`
directly rather than trusting this number.

## Testing

`npm test -- --run` (Vitest). 747 tests passing as of commit `c792420`. Convention: route handlers
and services get colocated `*.test.ts` files; React components do NOT get test files in this
codebase (verified - no `.tsx` test files exist anywhere) - don't add them unless the user asks or
the convention changes. Integration tests (discovery.service.dnc-preservation.test.ts,
bridge-budget.test.ts, hunter.source.test.ts, prospects.repository.test.ts,
daily-send-counter.test.ts, followup-scheduler.cap-integration.test.ts,
retention-scheduler.cap-integration.test.ts) hit the real Postgres DB at whatever `DATABASE_URL`
points at - **there is only one database, shared with the app**, so `npm test` writes/deletes real
rows there (`fileParallelism: false` in `vitest.config.ts` - these run sequentially, not racing each
other). Deliberate tradeoff, not an oversight.

**This already cost real data once** (a full set of discovered prospects, wiped by a routine
`npx vitest run` during the pro-UI-redesign session). All 7 of the files above now call
`assertDestructiveTestsAllowed()` (`src/common/testing/require-destructive-test-guard.ts`) in a
`beforeAll`, which throws immediately unless `CONFIRM_DESTRUCTIVE_TESTS=true` is set in the
environment - plain `npm test` / `npx vitest run` now fails those 7 files loudly (skipping their
tests, touching nothing) instead of silently wiping data. Only set that env var when you actually
mean to run them against a database you're fine losing data from - e.g.
`CONFIRM_DESTRUCTIVE_TESTS=true npx vitest run`.

`npm run typecheck` and `npx eslint .` should both be clean before committing anything.

## Working-style notes for this repo specifically

- Database is Neon (hosted Postgres), not local Docker - Docker is no longer part of this project at
  all (`docker-compose.yml` removed, `setup.ps1` no longer touches it). One `DATABASE_URL` in `.env`
  (never committed), shared by the app and the test suite - see Testing above.
- User is caveman-mode-terse in chat but expects normal prose in code/commits/PRs (per their global
  CLAUDE.md).
- Delegation policy (user's global CLAUDE.md): planner before non-trivial features, plan approval
  gate (present plan, wait for explicit go-ahead) before implementer, full test loop
  (implementer → test-writer → test-runner → code-reviewer → committer) before anything gets
  committed. This was followed for the full-UI buildout and caught 2 real bugs in review before
  they shipped - worth continuing to follow for anything non-trivial, not just as box-checking.
