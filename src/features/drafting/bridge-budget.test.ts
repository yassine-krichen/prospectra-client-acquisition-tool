import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/common/db/client';

import { isBridgeInCooldown, recordBridgeRateLimit } from './bridge-budget';

// Integration test against the real Postgres DB (same pattern as
// hunter.source.test.ts's ApiUsageCounter tests) - this is genuinely shared
// state read/written across separate serverless invocations, so it's worth
// exercising against real Postgres rather than a mocked Prisma client.
const SOURCE = 'claude-bridge';

beforeEach(async () => {
  await prisma.bridgeCooldown.deleteMany();
});

afterEach(async () => {
  await prisma.bridgeCooldown.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('isBridgeInCooldown', () => {
  it('reports false when no cooldown record exists for the source at all', async () => {
    expect(await isBridgeInCooldown(SOURCE)).toBe(false);
  });

  it('reports false when the record exists but blockedUntil is null', async () => {
    await prisma.bridgeCooldown.create({ data: { source: SOURCE, blockedUntil: null } });

    expect(await isBridgeInCooldown(SOURCE)).toBe(false);
  });

  it('reports true when blockedUntil is still in the future', async () => {
    await prisma.bridgeCooldown.create({
      data: { source: SOURCE, blockedUntil: new Date(Date.now() + 60_000) },
    });

    expect(await isBridgeInCooldown(SOURCE)).toBe(true);
  });

  it('reports false when blockedUntil has already passed', async () => {
    await prisma.bridgeCooldown.create({
      data: { source: SOURCE, blockedUntil: new Date(Date.now() - 60_000) },
    });

    expect(await isBridgeInCooldown(SOURCE)).toBe(false);
  });

  it('only reflects the record for the given source, not other sources', async () => {
    await prisma.bridgeCooldown.create({
      data: { source: 'chatgpt-bridge', blockedUntil: new Date(Date.now() + 60_000) },
    });

    expect(await isBridgeInCooldown(SOURCE)).toBe(false);
  });

  it('reports true (fail-closed) when the cooldown lookup throws', async () => {
    const findUniqueSpy = vi
      .spyOn(prisma.bridgeCooldown, 'findUnique')
      .mockRejectedValueOnce(new Error('connection reset'));

    expect(await isBridgeInCooldown(SOURCE)).toBe(true);

    findUniqueSpy.mockRestore();
  });
});

describe('recordBridgeRateLimit', () => {
  it('creates a new cooldown record set to now + retryAfterSeconds when none exists yet', async () => {
    const before = Date.now();
    await recordBridgeRateLimit(SOURCE, 120);
    const after = Date.now();

    const record = await prisma.bridgeCooldown.findUnique({ where: { source: SOURCE } });
    expect(record).not.toBeNull();
    expect(record?.blockedUntil?.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(record?.blockedUntil?.getTime()).toBeLessThanOrEqual(after + 120_000);
  });

  it('upserts (overwrites) blockedUntil on an existing record rather than erroring', async () => {
    await prisma.bridgeCooldown.create({
      data: { source: SOURCE, blockedUntil: new Date(Date.now() + 5_000) },
    });

    await recordBridgeRateLimit(SOURCE, 300);

    const record = await prisma.bridgeCooldown.findUnique({ where: { source: SOURCE } });
    expect(record?.blockedUntil?.getTime()).toBeGreaterThan(Date.now() + 250_000);
  });
});
