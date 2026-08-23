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

function cronRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/cron/seed-users', { method: 'POST', headers });
}

describe('POST /api/cron/seed-users', () => {
  it('rejects the request with 401 when the x-cron-secret header does not match', async () => {
    const response = await POST(cronRequest({ 'x-cron-secret': 'wrong-secret' }));

    expect(response.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('creates both accounts with passwordHash unset when neither exists yet', async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({});

    const response = await POST(cronRequest({ 'x-cron-secret': env.CRON_SECRET }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledWith({ data: { nickname: 'Noel' } });
    expect(createMock).toHaveBeenCalledWith({ data: { nickname: 'EvilWithin' } });
    expect(body).toEqual({
      results: [
        { nickname: 'Noel', created: true },
        { nickname: 'EvilWithin', created: true },
      ],
    });
  });

  it('never overwrites an account that already exists', async () => {
    findUniqueMock.mockResolvedValue({ id: 'existing-user' });

    const response = await POST(cronRequest({ 'x-cron-secret': env.CRON_SECRET }));
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
