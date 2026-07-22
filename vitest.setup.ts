// Default valid env vars so `src/common/config/env.ts` (which validates and
// throws at import time) doesn't blow up every test file that transitively
// imports it. `env.test.ts` mutates `process.env` and reloads the module per
// case to exercise the validation failure paths directly.
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/biz_scraper_test?schema=public"
process.env.DASHBOARD_PASSWORD ??= "test-password"
process.env.SESSION_SECRET ??= "test-session-secret-32-characters"
