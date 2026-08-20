const CONFIRM_ENV_VAR = 'CONFIRM_DESTRUCTIVE_TESTS';

/**
 * Call this in a top-level `beforeAll` in any test file that truncates real
 * tables (`prisma.*.deleteMany()` with no filter). This app has a single
 * shared DATABASE_URL - no separate test database (a deliberate choice, see
 * CLAUDE.md) - which means these tests write/delete real rows in whatever
 * database is currently configured. That already cost a full set of
 * real discovered prospects once: `npx vitest run` was run routinely as a
 * verification step, each run silently wiping the Prospect/Client/Job/
 * ApiUsageCounter tables via these exact tests, with nobody noticing until
 * the data was already gone.
 *
 * Refuses to proceed (throws, failing every test in the file) unless
 * `CONFIRM_DESTRUCTIVE_TESTS=true` is explicitly set in the environment -
 * an intentional, undismissable speed bump. Set it only when you actually
 * mean to run these against a database you're fine losing data from (e.g.
 * right before re-seeding, or against a database you've deliberately
 * pointed DATABASE_URL at for exactly this purpose).
 */
export function assertDestructiveTestsAllowed(testFileName: string): void {
  if (process.env[CONFIRM_ENV_VAR] !== 'true') {
    throw new Error(
      `${testFileName}: refusing to run. This test truncates real tables in whatever DATABASE_URL is ` +
        `currently configured - there is no separate test database in this project. Set ` +
        `${CONFIRM_ENV_VAR}=true in the environment only when you actually mean to wipe that database's ` +
        `Prospect/Client/Job/ApiUsageCounter/BridgeCooldown data.`
    );
  }
}
