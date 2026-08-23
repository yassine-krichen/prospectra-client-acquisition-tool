import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { findUniqueMock } = vi.hoisted(() => ({ findUniqueMock: vi.fn() }));
vi.mock('@/common/db/client', () => ({ prisma: { user: { findUnique: findUniqueMock } } }));

const { GET } = await import('./route');

afterEach(() => {
  findUniqueMock.mockReset();
});

function statusRequest(nickname: string | null): NextRequest {
  const url = new URL('http://localhost/api/login/status');
  if (nickname !== null) url.searchParams.set('nickname', nickname);
  return new NextRequest(url);
}

describe('GET /api/login/status', () => {
  it('rejects a missing nickname param with 400', async () => {
    const response = await GET(statusRequest(null));
    expect(response.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('rejects a nickname outside the two known accounts with 400', async () => {
    const response = await GET(statusRequest('RandomHacker'));
    expect(response.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('reports needsSetup: true when the account has no password yet', async () => {
    findUniqueMock.mockResolvedValue({ passwordHash: null });

    const response = await GET(statusRequest('Noel'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ needsSetup: true });
  });

  it('reports needsSetup: true when the account has not been provisioned at all yet', async () => {
    findUniqueMock.mockResolvedValue(null);

    const response = await GET(statusRequest('EvilWithin'));
    const body = await response.json();

    expect(body).toEqual({ needsSetup: true });
  });

  it('reports needsSetup: false once a password has been set', async () => {
    findUniqueMock.mockResolvedValue({ passwordHash: 'salt:hash' });

    const response = await GET(statusRequest('Noel'));
    const body = await response.json();

    expect(body).toEqual({ needsSetup: false });
  });
});
