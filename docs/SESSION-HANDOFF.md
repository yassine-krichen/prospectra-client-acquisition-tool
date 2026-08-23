# Session handoff — discovery engine v2

Read this FIRST in a fresh session picking up this branch. Written 2026-08-22 after the project
folder moved from `biz-scraper` to `freelance-client-acquisition-tool` (same git history, same
GitHub remote — nothing else changed).

## What this project is

Cold-outreach pipeline for a solo dev/agency operator: discover companies with visible technical
debt or buying signals → enrich contact info → AI-draft outreach → human approves in a queue →
send → follow up → convert to a paying client. Single shared-password dashboard, not multi-tenant.
See the repo root `CLAUDE.md` for the full app-level context (stack, architecture, known gotchas
like the env.ts client-bundle-leak hazard).

## The one rule that overrides everything else

**This project's shared Neon Postgres DB has lost real production data to destructive test
operations TWICE.** A structural fix now exists (destructive integration tests run against an
isolated `TEST_DATABASE_URL`, never the app's real `DATABASE_URL` — see `CLAUDE.md`'s Testing
section), but the discipline still matters: **never run `prisma migrate reset`, `db push
--force-reset`, or set `CONFIRM_DESTRUCTIVE_TESTS=true` casually** — not even while troubleshooting
something unrelated. If a subagent is spawned for any task touching this repo, that rule must be
stated explicitly in its prompt, every time, not assumed carried over.

## Current git state

- Branch: `feat/discovery-engine-v2`, pushed to `origin`, **not yet merged, no PR opened yet**.
- `gh` is not authenticated in this environment — PR creation was attempted and failed with a 401.
  Either run `gh auth login` first, or open the PR manually at:
  `https://github.com/yassine-krichen/biz-scraper/pull/new/feat/discovery-engine-v2`
- 10 commits ahead of `main` (`cc14bdd` through `1396e3f`) — full list via `git log --oneline main..HEAD`.
- Draft PR title/body was already written (ask the user if they still have it, or regenerate from
  the commit list + this doc — it covered: bug fixes, new Overpass source, GitHub re-architecture,
  priority-score v2, Patchright investigated-not-adopted).
- Everything on this branch has already been reviewed (code-reviewer agent) and tested (867 tests
  passing, 0 regressions against the pre-branch baseline).

## What's already shipped on this branch (don't redo)

**Reliability fixes (real bugs found and fixed, not just features):**
- Prospects with no domain (common from Yellow Pages/OSM) used to duplicate forever across
  re-discovery runs — dedup and persistence now also match on normalized phone/address.
- Indie Hackers' scraper selectors were completely stale (matched zero elements against the site's
  real DOM) for BOTH products and jobs — fixed against real captured fixtures.
- Yellow Pages/Indie Hackers Cloudflare blocks now retry with backoff instead of failing a whole
  run on the first hit (blocking is confirmed probabilistic, not absolute).
- **Overpass/OSM requests were getting HTTP 406** because the fetch call sent no headers at all —
  Node's `fetch` (undici) has different defaults than curl, and the Overpass public instance
  rejects unidentified requests. Fixed by sending a real `User-Agent` (reused from the existing
  Nominatim geocoding call). Verified live, reproduced and fixed in actual Node runtime, not
  assumed from curl testing (curl alone did NOT reproduce the bug — this one needed the real
  runtime to catch).
- `priorityScore` — already wired into the dashboard's prospect filter/sort UI — was a one-line
  stub (just signal strength, 1-3). Replaced with a real weighted formula.
- `isPriorityMarket`'s first cut incorrectly scored "West Virginia" as a match on "Virginia" via
  plain substring matching — caught in code review before merge, fixed with exact comma-segment
  matching instead.

**New capability:**
- OpenStreetMap/Overpass discovery source (free, geocoded via Nominatim, no anti-bot fight) — a
  new Branch A source alongside Google Places/Yellow Pages.
- First-party, no-API-key tech-stack detector (WordPress/Shopify/Wix/Webflow/Next.js/jQuery
  version/analytics-tag detection via plain HTML/header inspection) — BuiltWith is now a secondary
  cross-check on top of this, not the primary tech-stack source.
- Corroboration tracking (`Prospect.corroboratingSourceCount`) — a business found by 2+ independent
  sources now visibly counts for more confidence instead of the duplicate being silently discarded.
- Priority-market scoring bonus (high-value US states/EU countries) — a soft scoring signal, never
  a hard filter; free-text geography still works for any location.

**Re-architected (correctness fix, not just refactor):**
- GitHub moved from an independent discovery source (any random unrelated repo could become a
  "discovered business") to enrichment-only evidence for an already-found SaaS-industry company —
  gated to `industry === 'saas'` to conserve its unauthenticated 60/hour rate limit, and requires
  the matched GitHub account's own listed website to actually equal the prospect's domain before
  attaching any evidence (avoids false-positive collisions).
- A prospect with nothing actionable left after the full enrichment chain runs (no domain/website/
  phone/address, no real signal beyond the baseline fallback) is now discarded instead of
  persisted as unusable dead weight.

**Investigated and deliberately NOT adopted:**
- Patchright (a stealth-patched Playwright fork) was actually benchmarked against the current
  manual-stealth setup — measured, not assumed. Result: no improvement, because Patchright's own
  documented advantage requires **headed** browser mode, and this app runs headless on a server
  with no display. Don't re-litigate this without a reason the constraint has changed (e.g. adding
  Xvfb/a virtual display).

## The full plan — what's left (goal: make discovery the best it can be, free-of-cost)

This branch's purpose traces back to a long design conversation (the user discussing the discovery
architecture with GPT, then having that analysis critically reviewed and reconciled into an actual
scoped plan). **The complete plan, vision, and reasoning already lives in
`docs/discovery-engine-roadmap.md` in this repo — read that file in full before planning any new
work. Do not re-derive the vision from scratch; it's already been thought through once.** What
follows here is a condensed pointer, not a replacement for reading that file.

Deferred items, in the priority order already decided (with reasoning already worked out — see the
roadmap doc for the full effort/risk assessment behind each):

1. **Government business registry connectors** — decided: start with **UK Companies House** (free,
   clean documented API) and **one US state, Texas** (matches where this app's actual prospect data
   already is — Austin — more relevant than e.g. Delaware). Each new registry is its own connector
   file + its own `ProspectSource` enum value/migration. While touching that enum, also fix the
   pre-existing debt where `yellowpages`/`overpass` both currently fall back to `source: 'manual'`
   because neither has its own enum value.
2. **Full entity resolution** — the corroboration-count step already shipped is the stepping stone;
   the actual weighted-confidence/fuzzy-match engine described in the roadmap doc is still ahead.
3. **Map UI (Leaflet)** — deliberately waiting. Only the Overpass source currently populates
   `Prospect.location`'s lat/lng; a map today would be sparse and misrepresent real coverage.
   Revisit once a registry connector or a fixed Google Places (billing) adds more coordinate data.
4. **Job board scraping / search-engine-as-signal scraping** — deliberately parked. Real ToS/
   anti-bot risk worse than what's already been fought this branch (LinkedIn/Indeed/Google are
   harder, more aggressively enforced targets than Cloudflare-on-yellowpages), and the
   Patchright-benchmark finding (headless-only stealth has a real ceiling) makes this an even worse
   bet now than when first deferred.

Also outstanding, smaller items:
- Product Hunt's API token is expired/revoked — needs the user to regenerate it manually at
  producthunt.com/v2/oauth/applications. Not a code fix.
- The PR for this whole branch still needs to actually get created/merged (see "Current git state"
  above).

## How to work in this repo (process, not just code)

- **Delegate, don't do it inline** — Explore for search, planner before non-trivial work, plan
  approval gate (present plan, wait for explicit go-ahead) before implementer, full loop
  (implementer → test-writer if needed → test-runner → code-reviewer → committer) before anything
  gets committed. This was followed rigorously on this branch and caught multiple real bugs before
  they shipped (the West Virginia scoring bug, the stale Indie Hackers selectors, the Overpass 406)
  — worth continuing exactly this way, not shortcutting it.
- Commits on this branch never carry a `Co-Authored-By`/`Claude-Session` trailer (explicit user
  preference, applies globally per the user's own `~/.claude/CLAUDE.md`).
- When scoping new work: match the size of past slices on this branch (5 items, then 3 items) —
  don't try to build the whole remaining roadmap in one pass. Get user sign-off on scope before
  building, same as every slice so far.
