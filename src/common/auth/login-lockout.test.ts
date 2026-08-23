import { afterEach, describe, expect, it, vi } from 'vitest';

const { findUniqueMock, upsertMock, updateMock, deleteManyMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  upsertMock: vi.fn(),
  updateMock: vi.fn(),
  deleteManyMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: {
    loginLockout: {
      findUnique: findUniqueMock,
      upsert: upsertMock,
      update: updateMock,
      deleteMany: deleteManyMock,
    },
  },
}));

const { isLockedOut, recordFailedAttempt, clearLockout } = await import('./login-lockout');

const NICKNAME = 'Noel';

afterEach(() => {
  findUniqueMock.mockReset();
  upsertMock.mockReset();
  updateMock.mockReset();
  deleteManyMock.mockReset();
});

describe('isLockedOut', () => {
  it('reports false when no lockout record exists for the nickname at all', async () => {
    findUniqueMock.mockResolvedValue(null);

    expect(await isLockedOut(NICKNAME)).toBe(false);
  });

  it('reports false when the record exists but lockedUntil is null', async () => {
    findUniqueMock.mockResolvedValue({ nickname: NICKNAME, failedAttempts: 2, lockedUntil: null });

    expect(await isLockedOut(NICKNAME)).toBe(false);
  });

  it('reports true when lockedUntil is still in the future', async () => {
    findUniqueMock.mockResolvedValue({
      nickname: NICKNAME,
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    expect(await isLockedOut(NICKNAME)).toBe(true);
  });

  it('reports false when lockedUntil has already passed', async () => {
    findUniqueMock.mockResolvedValue({
      nickname: NICKNAME,
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() - 60_000),
    });

    expect(await isLockedOut(NICKNAME)).toBe(false);
  });

  it('reports true (fail-closed) when the lockout lookup throws', async () => {
    findUniqueMock.mockRejectedValue(new Error('connection reset'));

    expect(await isLockedOut(NICKNAME)).toBe(true);
  });
});

describe('recordFailedAttempt', () => {
  it('creates a new lockout record at failedAttempts 1 when none exists yet, without locking', async () => {
    upsertMock.mockResolvedValue({ nickname: NICKNAME, failedAttempts: 1, lockedUntil: null });

    await recordFailedAttempt(NICKNAME);

    expect(upsertMock).toHaveBeenCalledWith({
      where: { nickname: NICKNAME },
      create: { nickname: NICKNAME, failedAttempts: 1 },
      update: { failedAttempts: { increment: 1 } },
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not lock the account below the 5-failure threshold', async () => {
    upsertMock.mockResolvedValue({ nickname: NICKNAME, failedAttempts: 4, lockedUntil: null });

    await recordFailedAttempt(NICKNAME);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('locks the account for 15 minutes once failedAttempts reaches 5', async () => {
    upsertMock.mockResolvedValue({ nickname: NICKNAME, failedAttempts: 5, lockedUntil: null });

    const before = Date.now();
    await recordFailedAttempt(NICKNAME);
    const after = Date.now();

    expect(updateMock).toHaveBeenCalledTimes(1);
    const updateCall = updateMock.mock.calls[0][0];
    expect(updateCall.where).toEqual({ nickname: NICKNAME });
    const lockedUntil = updateCall.data.lockedUntil.getTime();
    expect(lockedUntil).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
    expect(lockedUntil).toBeLessThanOrEqual(after + 15 * 60 * 1000);
  });
});

describe('clearLockout', () => {
  it('deletes any lockout record for the nickname', async () => {
    deleteManyMock.mockResolvedValue({ count: 1 });

    await clearLockout(NICKNAME);

    expect(deleteManyMock).toHaveBeenCalledWith({ where: { nickname: NICKNAME } });
  });
});
