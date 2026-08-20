import { afterEach, describe, expect, it } from 'vitest';

import { assertDestructiveTestsAllowed } from './require-destructive-test-guard';

const ENV_VAR = 'CONFIRM_DESTRUCTIVE_TESTS';
const original = process.env[ENV_VAR];

describe('assertDestructiveTestsAllowed', () => {
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
  });

  it('throws when CONFIRM_DESTRUCTIVE_TESTS is unset', () => {
    delete process.env[ENV_VAR];
    expect(() => assertDestructiveTestsAllowed('some.test.ts')).toThrow(/refusing to run/i);
  });

  it('throws when CONFIRM_DESTRUCTIVE_TESTS is set to anything other than exactly "true"', () => {
    process.env[ENV_VAR] = '1';
    expect(() => assertDestructiveTestsAllowed('some.test.ts')).toThrow();

    process.env[ENV_VAR] = 'yes';
    expect(() => assertDestructiveTestsAllowed('some.test.ts')).toThrow();
  });

  it('does not throw when CONFIRM_DESTRUCTIVE_TESTS is exactly "true"', () => {
    process.env[ENV_VAR] = 'true';
    expect(() => assertDestructiveTestsAllowed('some.test.ts')).not.toThrow();
  });

  it('includes the test file name in the error message', () => {
    delete process.env[ENV_VAR];
    expect(() => assertDestructiveTestsAllowed('prospects.repository.test.ts')).toThrow(/prospects\.repository\.test\.ts/);
  });
});
