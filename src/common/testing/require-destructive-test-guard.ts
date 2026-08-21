const CONFIRM_ENV_VAR = 'CONFIRM_DESTRUCTIVE_TESTS';

/**
 * Call this in a top-level `beforeAll` in any test file that truncates real
 * tables (`prisma.*.deleteMany()` with no filter). This project's shared
 * `DATABASE_URL` has already lost real prospect data twice this way - a
 * routine `npx vitest run`, run as a verification step, silently wiping the
 * Prospect/Client/Job/ApiUsageCounter tables via these exact tests, with
 * nobody noticing until the data was already gone.
 *
 * These tests now run against an isolated `TEST_DATABASE_URL` (a separate
 * Neon branch - see `.env.example` and `test-db-client.ts`), not the app's
 * real `DATABASE_URL`, so a repeat of that incident structurally can't
 * happen even if this guard is bypassed. This function still enforces three
 * independent conditions, each with its own error message, before letting a
 * destructive test file proceed:
 *
 * 1. `CONFIRM_DESTRUCTIVE_TESTS=true` is explicitly set - an intentional,
 *    undismissable speed bump. Set it only when you actually mean to wipe
 *    whatever `TEST_DATABASE_URL` points at.
 * 2. `TEST_DATABASE_URL` is actually configured - without it there's no
 *    isolated database to run against at all.
 * 3. `TEST_DATABASE_URL` is not the same value as `DATABASE_URL` - refused
 *    regardless of the flag above. This is the direct guard against the
 *    exact mistake that caused both incidents: pointing the "test" database
 *    at the real one.
 */
export function assertDestructiveTestsAllowed(testFileName: string): void {
  if (process.env[CONFIRM_ENV_VAR] !== 'true') {
    throw new Error(
      `${testFileName}: refusing to run. This test truncates real tables in whatever TEST_DATABASE_URL is ` +
        `currently configured. Set ${CONFIRM_ENV_VAR}=true in the environment only when you actually mean to ` +
        `wipe that database's Prospect/Client/Job/ApiUsageCounter/BridgeCooldown data.`
    );
  }

  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      `${testFileName}: refusing to run. TEST_DATABASE_URL is not configured - these tests need a dedicated ` +
        `Neon branch, separate from DATABASE_URL. See the TEST_DATABASE_URL comment in .env.example for how ` +
        `to create one.`
    );
  }

  if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
    throw new Error(
      `${testFileName}: refusing to run. TEST_DATABASE_URL is identical to DATABASE_URL - this test would ` +
        `truncate the real production database. TEST_DATABASE_URL must point at a separate Neon branch. ` +
        `This check cannot be bypassed by ${CONFIRM_ENV_VAR}.`
    );
  }
}
