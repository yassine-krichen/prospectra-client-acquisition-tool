import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/common/config/env';

const { findUniqueMock, createMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: { user: { findUnique: findUniqueMock, create: createMock } },
}));

const { POST } = await import('./route');

afterEach(() => {
  findUniqueMock.mockReset();
  createMock.mockReset();
});

function cronRequest(headers: Record<string, string> = {}, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/cron/seed-users', {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/cron/seed-users', () => {
  it('rejects the request with 401 when the x-cron-secret header does not match', async () => {
    const response = await POST(cronRequest({ 'x-cron-secret': 'wrong-secret' }));

    expect(response.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('creates an account when a valid password is provided for it, hashing the password before storing it', async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({});

    const response = await POST(
      cronRequest(
        { 'x-cron-secret': env.CRON_SECRET, 'Content-Type': 'application/json' },
        { passwords: { Noel: 'a-strong-password', EvilWithin: 'another-strong-password' } }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(2);

    const noelCall = createMock.mock.calls.find((call) => call[0].data.nickname === 'Noel')?.[0];
    expect(noelCall.data.passwordHash).not.toBe('a-strong-password');
    expect(typeof noelCall.data.passwordHash).toBe('string');

    expect(body).toEqual({
      results: [
        { nickname: 'Noel', created: true },
        { nickname: 'EvilWithin', created: true },
      ],
    });
  });

  it('skips creating an account with no password provided, reporting a per-nickname error, while still creating others', async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({});

    const response = await POST(
      cronRequest(
        { 'x-cron-secret': env.CRON_SECRET, 'Content-Type': 'application/json' },
        { passwords: { EvilWithin: 'a-strong-password' } }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      data: { nickname: 'EvilWithin', passwordHash: expect.any(String) },
    });
    expect(body).toEqual({
      results: [
        { nickname: 'Noel', created: false, error: 'password required (min 8 characters)' },
        { nickname: 'EvilWithin', created: true },
      ],
    });
  });

  it('skips creating an account whose provided password is too short', async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({});

    const response = await POST(
      cronRequest(
        { 'x-cron-secret': env.CRON_SECRET, 'Content-Type': 'application/json' },
        { passwords: { Noel: 'short', EvilWithin: 'a-strong-password' } }
      )
    );
    const body = await response.json();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(body.results).toContainEqual({
      nickname: 'Noel',
      created: false,
      error: 'password required (min 8 characters)',
    });
  });

  it('never overwrites an account that already exists', async () => {
    findUniqueMock.mockResolvedValue({ id: 'existing-user' });

    const response = await POST(
      cronRequest(
        { 'x-cron-secret': env.CRON_SECRET, 'Content-Type': 'application/json' },
        { passwords: { Noel: 'a-strong-password', EvilWithin: 'another-strong-password' } }
      )
    );
    const body = await response.json();

    expect(createMock).not.toHaveBeenCalled();
    expect(body).toEqual({
      results: [
        { nickname: 'Noel', created: false },
        { nickname: 'EvilWithin', created: false },
      ],
    });
  });
});
