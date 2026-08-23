import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password-hash';

describe('hashPassword / verifyPassword', () => {
  it('verifies the correct password against its own hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword('correct-horse-battery-staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time (random salt per password)', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');

    expect(first).not.toBe(second);
    await expect(verifyPassword('same-password', first)).resolves.toBe(true);
    await expect(verifyPassword('same-password', second)).resolves.toBe(true);
  });

  it('fails closed on a malformed stored hash instead of throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-valid-stored-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });
});
