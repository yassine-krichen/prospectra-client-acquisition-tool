import { afterEach, describe, expect, it } from 'vitest';

import { assertDestructiveTestsAllowed } from './require-destructive-test-guard';

const CONFIRM_ENV_VAR = 'CONFIRM_DESTRUCTIVE_TESTS';
const TEST_DB_ENV_VAR = 'TEST_DATABASE_URL';
const DB_ENV_VAR = 'DATABASE_URL';

const originalConfirm = process.env[CONFIRM_ENV_VAR];
const originalTestDb = process.env[TEST_DB_ENV_VAR];
const originalDb = process.env[DB_ENV_VAR];

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('assertDestructiveTestsAllowed', () => {
  afterEach(() => {
    restore(CONFIRM_ENV_VAR, originalConfirm);
    restore(TEST_DB_ENV_VAR, originalTestDb);
    restore(DB_ENV_VAR, originalDb);
  });

  it('throws when CONFIRM_DESTRUCTIVE_TESTS is unset', () => {
    delete process.env[CONFIRM_ENV_VAR];
    expect(() => assertDestructiveTestsAllowed('some.test.ts')).toThrow(/refusing to run/i);
  });

  it('throws when CONFIRM_DESTRUCTIVE_TESTS is set to anything other than exactly "true"', () => {
    process.env[CONFIRM_ENV_VAR] = '1';
    expect(() => assertDestructiveTestsAllowed('some.test.ts')).toThrow();

    process.env[CONFIRM_ENV_VAR] = 'yes';
    expect(() => assertDestructiveTestsAllowed('some.test.ts')).toThrow();
  });

  it('includes the test file name in the error message', () => {
    delete process.env[CONFIRM_ENV_VAR];
    expect(() => assertDestructiveTestsAllowed('prospects.repository.test.ts')).toThrow(/prospects\.repository\.test\.ts/);
  });

  it('throws a distinct "TEST_DATABASE_URL not configured" error when the flag is set but TEST_DATABASE_URL is unset', () => {
    process.env[CONFIRM_ENV_VAR] = 'true';
    delete process.env[TEST_DB_ENV_VAR];
    process.env[DB_ENV_VAR] = 'postgresql://user:pass@host/prod';

    expect(() => assertDestructiveTestsAllowed('some.test.ts')).toThrow(/TEST_DATABASE_URL is not configured/i);
  });

  it('throws a distinct "identical to DATABASE_URL" error when TEST_DATABASE_URL equals DATABASE_URL, even with the flag set', () => {
    process.env[CONFIRM_ENV_VAR] = 'true';
    process.env[DB_ENV_VAR] = 'postgresql://user:pass@host/same-db';
    process.env[TEST_DB_ENV_VAR] = 'postgresql://user:pass@host/same-db';

    expect(() => assertDestructiveTestsAllowed('some.test.ts')).toThrow(/identical to DATABASE_URL/i);
  });

  it('does not throw when the flag is "true", TEST_DATABASE_URL is set, and it differs from DATABASE_URL', () => {
    process.env[CONFIRM_ENV_VAR] = 'true';
    process.env[DB_ENV_VAR] = 'postgresql://user:pass@host/prod';
    process.env[TEST_DB_ENV_VAR] = 'postgresql://user:pass@host/test-branch';

    expect(() => assertDestructiveTestsAllowed('some.test.ts')).not.toThrow();
  });
});
