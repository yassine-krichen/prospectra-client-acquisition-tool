import "dotenv/config"

// Default valid env vars so `src/common/config/env.ts` (which validates and
// throws at import time) doesn't blow up every test file that transitively
// imports it. `env.test.ts` mutates `process.env` and reloads the module per
// case to exercise the validation failure paths directly.
//
// DATABASE_URL comes from `.env` (loaded above via dotenv/config) - the same
// Neon database the app itself uses. The integration tests that hit a real
// Postgres (discovery.service.dnc-preservation.test.ts, bridge-budget.test.ts,
// hunter.source.test.ts, prospects.repository.test.ts,
// daily-send-counter.test.ts, followup-scheduler.cap-integration.test.ts,
// retention-scheduler.cap-integration.test.ts) truncate/write real rows
// there, so `npm test` will touch whatever DATABASE_URL points at. Falls
// back to an unreachable-but-URL-shaped placeholder when `.env` doesn't
// define DATABASE_URL at all, so env.ts's `.url()` validation still passes
// for every other test file.
process.env.DATABASE_URL ??= "postgresql://unset:unset@localhost:5432/unset?schema=public"
process.env.DASHBOARD_PASSWORD ??= "test-password"
process.env.SESSION_SECRET ??= "test-session-secret-32-characters"
process.env.CRON_SECRET ??= "test-cron-secret-32-characters-long"
