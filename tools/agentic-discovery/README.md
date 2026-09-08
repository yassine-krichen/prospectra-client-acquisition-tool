# Agentic discovery (standalone tool)

A standalone, terminal-only mini-tool that uses the headless `claude` CLI to research and find real
business prospects via web search/fetch, then writes them into this app's Postgres DB as `Prospect`
rows through the exact same dedupe/persist pipeline the built-in discovery sources use. Lives
outside `src/` on purpose - it is not part of the Next.js app and is never imported by it.

## Prerequisites

- The `claude` CLI must already be installed and logged in on this machine. This tool has **no
  separate API key of its own** - it shells out to your already-authenticated `claude` CLI session.
- `.env` at the repo root must have `DATABASE_URL` set (the real app database, or a test branch - up
  to you). It must also have `SESSION_SECRET` and `CRON_SECRET` set, even though this tool never
  uses them directly: it imports the shared Prisma client (`@/common/db/client`), which imports
  `@/common/config/env`, which validates all three at module-import time and throws if any are
  missing.

## Running it

```
npm run discover:agentic -- --category "law firm" --geography "New York, NY" --count 8
```

All three flags are optional:

- `--category` defaults to today's rotation entry from `pickDailyCategory` (same fixed New York
  category list the automated discovery cron uses).
- `--geography` defaults to `"New York, NY"`.
- `--count` defaults to `8`.

## What it does

1. Builds a research prompt (`prompt-template.ts`) instructing the agent to find real companies
   matching the category/geography, verify a technical-debt/opportunity signal by actually fetching
   their site (never from a search snippet or the model's own prior knowledge), and output the
   result as JSONL.
2. Runs `claude -p` headlessly (`claude-cli.ts`) with only `WebSearch` and `WebFetch` tools enabled -
   no `Bash`, `Write`, or `Edit` access. The agent cannot touch the filesystem or run commands, only
   read the web.
3. Parses the returned JSONL line-by-line, validating each line against `agenticProspectLineSchema`.
   Malformed JSON or schema-invalid lines are skipped and reported, not silently dropped.
4. Maps valid lines into the same `DiscoveredProspect` shape every other discovery source produces
   (`map-to-discovered-prospect.ts`), then reuses `dedupeProspects`/`persistProspect` from
   `discovery.service.ts` unchanged - no separate/duplicated persistence logic.
5. Prints a summary: lines found, valid/invalid counts (with each invalid line's raw text and
   error), deduped-within-batch count, and inserted/updated/skipped-do-not-contact counts.

## Safety notes

- Nothing is written to the DB without passing schema validation first.
- Dedup and do-not-contact enforcement reuse the real pipeline's own functions - a prospect that
  already opted out or was marked do-not-contact is left untouched, exactly as it would be from any
  other discovery source.
- The agent is restricted to `WebSearch`/`WebFetch` only - it cannot run shell commands or modify any
  files, on this machine or elsewhere.

## v1 limitations

- Single category/geography per run - no batching over multiple categories in one invocation.
- No discovery-run history entry is written (`DiscoveryRun` rows are only created by the main
  `runDiscovery` orchestrator in `discovery.service.ts`, not by this tool).
