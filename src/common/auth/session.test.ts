import { describe, expect, it, vi } from 'vitest';

import { createSessionToken, verifySessionToken } from './session';

const PAYLOAD = { userId: 'user-cuid-1', nickname: 'Noel' };

describe('createSessionToken / verifySessionToken', () => {
  it('round-trips a freshly created token through verification', async () => {
    const token = await createSessionToken(PAYLOAD);

    await expect(verifySessionToken(token)).resolves.toEqual(PAYLOAD);
  });

  it('rejects an undefined token', async () => {
    await expect(verifySessionToken(undefined)).resolves.toBeNull();
  });

  it('rejects an empty string token', async () => {
    await expect(verifySessionToken('')).resolves.toBeNull();
  });

  it('rejects a token missing segments', async () => {
    await expect(verifySessionToken('user-cuid-1.Noel')).resolves.toBeNull();
    await expect(verifySessionToken('user-cuid-1')).resolves.toBeNull();
  });

  it('rejects a token with a tampered signature, without throwing', async () => {
    const token = await createSessionToken(PAYLOAD);
    const parts = token.split('.');
    const signature = parts.at(-1)!;
    const tamperedSignature = signature.slice(0, -1) + (signature.at(-1) === 'a' ? 'b' : 'a');
    const tamperedToken = [...parts.slice(0, -1), tamperedSignature].join('.');

    await expect(verifySessionToken(tamperedToken)).resolves.toBeNull();
  });

  it('rejects a token with a tampered userId (signature no longer matches)', async () => {
    const token = await createSessionToken(PAYLOAD);
    const [, nickname, issuedAt, signature] = token.split('.');
    const tamperedToken = `some-other-user-id.${nickname}.${issuedAt}.${signature}`;

    await expect(verifySessionToken(tamperedToken)).resolves.toBeNull();
  });

  it('rejects a token with a tampered nickname (signature no longer matches)', async () => {
    const token = await createSessionToken(PAYLOAD);
    const [userId, , issuedAt, signature] = token.split('.');
    const tamperedToken = `${userId}.EvilWithin.${issuedAt}.${signature}`;

    await expect(verifySessionToken(tamperedToken)).resolves.toBeNull();
  });

  it('rejects arbitrary garbage input without throwing', async () => {
    await expect(verifySessionToken('not.a.valid.token.at.all')).resolves.toBeNull();
    await expect(verifySessionToken('....')).resolves.toBeNull();
  });

  it('never expires - a token from a year in the past still verifies today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const token = await createSessionToken(PAYLOAD);
    vi.useRealTimers();

    await expect(verifySessionToken(token)).resolves.toEqual(PAYLOAD);
  });
});
