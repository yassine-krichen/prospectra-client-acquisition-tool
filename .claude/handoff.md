# Handoff

Kept up to date automatically (reminded via PreCompact/SessionEnd hooks - see `.claude/settings.json`,
though those hooks can only show a UI message, not force an update - see "Key decisions" below)
so a new session can resume without re-deriving context. Overwrite this file's content each update -
it's a snapshot, not a log. Keep it short: only what's needed to resume accurately.

## Git state

- Branch: `main`. This session's work was committed and pushed to `origin/main` - check
  `git log --oneline -5` for the real commit(s); this file won't chase that number as it drifts.
- No open branches/PRs from this session.

## What this session built (all on `/prospects` + sending pipeline, all live-verified with Playwright)

Roughly in order:
1. Last-opened-prospect row highlight; fixed hardcoded `text-white` company-name link (invisible in
   light mode) and too-faint dark-mode highlight opacity.
2. "Reason contains" filter → combobox (`ReasonFilterCombobox`, `GET /api/prospects/reasons`).
3. Status column → "Discovered" column (date + relative days); Status filter removed from the UI
   (backend `status` filter capability untouched).
4. Removed Verified email / Draft failure / Priority min-max / Sort by filters from the UI (backend
   capability untouched).
5. Toasts no longer auto-dismiss (`duration: Infinity` in `components/ui/sonner.tsx`) - must click X.
6. Every inline "red line" page-level error banner replaced with `toastError(...)` (prospects table,
   client detail, prospect dialog, approval queue, system health, login page). **Flagged, not
   confirmed**: login page's wrong-password message moved from inline-by-the-field to a toast, for
   consistency - user may want it reverted to inline.
7. **"Opened" column**: Yes/No + date/time + "by <nickname>" - new `Prospect.lastOpenedAt`/
   `lastOpenedByNickname`, `POST /api/prospects/[id]/open` (identity from session cookie, not
   client-supplied).
8. **"Domain" column**: Yes/No based on `prospect.domain`. **"Sent" column**: changed from a date to
   Yes/No.
9. Next.js bumped 16.3.2 → 16.3.3.
10. **Table width fix**: rebalanced every column's `size`; real bugs found live - the old "unsized
    column absorbs leftover space" comment was never true, and `whitespace-nowrap` headers/cells
    bleed into the next column instead of wrapping when too narrow (the real cause of horizontal
    scroll, not proportional-rescale rounding as first suspected). Fixed via explicit sizes,
    shortened two header labels, and `whitespace-normal` on the Opened column's multi-line cell.
11. Added "Has domain" and "Opened" filters (Yes/No/All) - new `BooleanFilterSelect` component.
12. **Prospect comments**: new `ProspectComment` model (full history, not a single field), textarea +
    "Add comment" in the detail dialog, shows "Comment by: <nickname> · <timestamp>" - verified
    genuinely shared across accounts (Noel adds one, EvilWithin sees it). Author resolved
    server-side from the session cookie.
13. **Critical-improvements audit** (via a research agent) found: BuiltWith and PeopleDataLabs had NO
    cost cap at all (unlike Hunter's atomic `ApiUsageCounter`-backed cap) - fixed both with the same
    pattern (`BUILTWITH_MONTHLY_CAP`/`PEOPLE_DATA_LABS_MONTHLY_CAP` env vars, default 100, NOT
    verified against a real account like Hunter's is - override to match your actual plan). Also
    capped `POST /api/prospects/bulk/enrich` at 100 ids.
14. **Daily send-cap race fix**: the cap check was read-then-compare (`getTodaysSendCount() >= cap`),
    which two concurrent requests (two tabs, or a manual trigger racing the daily cron) could both
    pass before either's send lands. Replaced with a real atomic reservation - new `DailySendCounter`
    table + `reserveDailySendSlot`/`rollBackDailySendSlot` (daily-send-counter.ts), wired into all
    three send paths (`send-queue.service.ts` approvals, `followup-scheduler.ts`,
    `retention-scheduler.ts`) with rollback on every non-success exit path. `getTodaysSendCount()`
    itself is UNCHANGED and still the source of truth for DISPLAY (queue page's "N of M sends today"
    banner, system health) - the new counter is a separate, dedicated enforcement gate.
15. **A second real bug found *by* testing fix #14**: a concurrency test firing 20 simultaneous
    reservation attempts caught `upsert` itself throwing a raw unique-constraint error under a real
    concurrent burst on the same key (`upsert` is create-then-update under the hood, not atomic
    against a burst of callers racing to create the same row). Fixed in ALL FOUR places using this
    pattern (the new `DailySendCounter` reservation, plus Hunter/BuiltWith/PeopleDataLabs quotas) by
    switching `upsert` → `createMany({ skipDuplicates: true })`, which Postgres compiles to a single
    atomic `INSERT ... ON CONFLICT DO NOTHING`. Verified for real: ran the full destructive-guarded
    suite against `TEST_DATABASE_URL` (`CONFIRM_DESTRUCTIVE_TESTS=true`) - 110 files, 1063 tests, all
    passing, including new tests that fire real concurrent load against actual Postgres and assert
    exactly `cap` reservations succeed.
16. **Domain-less "how do we contact them" investigation**: found `Prospect.phone`/`.address` were
    already captured at discovery time (Yellow Pages, OpenStreetMap) but NEVER selected, exposed via
    the API, or shown anywhere - completely invisible, unused real data. Fixed: surfaced Phone/
    Address in the prospect detail dialog; Google Places' existing Place Details call now also
    requests `formatted_phone_number`/`formatted_address` (same legacy-API field-category tier as
    `website`, which it already fetches - not a new cost tier, though this source is currently
    dormant since billing isn't enabled on `GOOGLE_PLACES_API_KEY`, per CLAUDE.md); Recommended
    Action now says **"Call {phone}"** instead of "Find website first" whenever a domain-less
    prospect has a phone on file. Verified live against real existing data in the DB - several
    real prospects flipped from a dead-end recommendation to an actionable one.
17. Dark mode background + sidebar changed to pure black (`oklch(0 0 0)` in `app/globals.css`) -
    cards/dialogs/popovers deliberately left untouched (not asked).
18. Added automatic handoff-file behavior: `.claude/handoff.md` (this file) + `.claude/settings.json`
    with `PreCompact`/`SessionEnd` hooks. See "Key decisions" below for a real limitation found in
    that mechanism.

## Open items / TODOs

- Ask the user to confirm the login-page toast change (item 6 above) - possible they want it
  reverted to inline-next-to-field.
- `SENDING_DOMAIN`/`BUILTWITH_MONTHLY_CAP`/`PEOPLE_DATA_LABS_MONTHLY_CAP` defaults are NOT verified
  against real account plans (unlike Hunter's carefully-verified 50/month) - revisit once the user
  knows their actual BuiltWith/PDL plan tier.
- See `CLAUDE_HANDOFF.md` (repo root) for older unresolved items from a prior session, not
  re-verified this session: Vercel Cron never confirmed firing, no `SENDING_DOMAIN` configured yet,
  Playwright/`@sparticuz/chromium` fix unverified on a real Vercel deploy.
- Google Places source's phone/address fetch is untested against the real Google API (billing
  disabled on that key) - only unit-tested with mocked responses.

## Key decisions / constraints to remember

- `CLAUDE.md` gained several sections this session (user-authored): "Frontend Verification"
  (Playwright CLI - live-verify UI changes, headed browser + screenshots, don't claim a frontend
  task done from source inspection alone), "Output & Context Efficiency" (terse responses), and
  "Context7" (use for version-sensitive library docs - now actually connected as an MCP server,
  confirmed working).
- Test auth workaround (approved by the user, reuse without re-asking): no real `Noel`/`EvilWithin`
  passwords are known. A short read-only `tsx` script mints a valid session cookie locally using
  `SESSION_SECRET` + `createSessionToken` (no password touched, no DB writes), then Playwright sets
  it as a cookie. Never reseed/reset the real accounts. **Always clean up any test data written
  through the UI while verifying** (e.g. a test comment) - check first (list/query), then delete
  only what you created; don't assume nothing else exists under that account.
- `.claude/settings.json` hooks (`PreCompact`/`SessionEnd`) can only emit a `systemMessage` shown to
  the *user* - `hookSpecificOutput.additionalContext` is NOT valid for these two events (confirmed
  via a real validation error), so they cannot inject a reminder into the model's own context or
  force an automatic update of this file. The user chose to keep this UI-message-only behavior.
- **The dev server needs restarting after any `npx prisma generate`** (schema change) - this bit us
  three separate times this session (500 errors on every API route until restart). Check
  `netstat -ano | grep ":3000"` for the PID, kill it, `npm run dev` again, confirm a clean
  `GET /prospects 200` in the log before trusting anything else.
- Whenever editing `prospects-table.tsx`'s column `size`s again: `table-layout: fixed` + `w-full`
  proportionally rescales every declared size to fill the container - the actual rendered width per
  column is NOT the literal declared px value. Verify with a live `getBoundingClientRect()`
  measurement, not the numbers on paper. Separately: `TableHead`/`TableCell` default to
  `whitespace-nowrap` - a header label or cell content wider than its column's width will visibly
  bleed into the next column instead of being contained: shorten the label or add
  `whitespace-normal break-words` to the cell content, don't fight it with CSS overflow tricks
  (tried `overflow-x-hidden` on the scroll container once - it just silently clips real text).
- **`upsert` is not safe against a genuine concurrent burst of callers racing to create the same
  row** (can throw a raw unique-constraint error instead of falling back to update) - use
  `createMany({ data: [...], skipDuplicates: true })` instead for any "ensure this row exists"
  step that might run under real concurrency. All four atomic-quota-style counters in this codebase
  (`DailySendCounter`, Hunter/BuiltWith/PeopleDataLabs `ApiUsageCounter`) already use this; don't
  reintroduce `upsert` for a new one without re-reading this note.
