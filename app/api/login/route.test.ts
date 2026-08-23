import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_NAME, verifySessionToken } from '@/common/auth/session';
import { hashPassword } from '@/common/auth/password-hash';

const { findUniqueMock, updateMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: { user: { findUnique: findUniqueMock, update: updateMock } },
}));

const { POST } = await import('./route');

afterEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
});

function loginRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

function rawLoginRequest(rawBody: string): NextRequest {
  return new NextRequest('http://localhost/api/login', { method: 'POST', body: rawBody });
}

describe('POST /api/login', () => {
  it('rejects a missing nickname/password with 400 and sets no session cookie', async () => {
    const response = await POST(loginRequest({}));

    expect(response.status).toBe(400);
    expect(response.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON bodies with 400 instead of throwing', async () => {
    const response = await POST(rawLoginRequest('not-json'));

    expect(response.status).toBe(400);
  });

  it('rejects a nickname that is not one of the two known accounts, without querying the database', async () => {
    const response = await POST(loginRequest({ nickname: 'RandomHacker', password: 'whatever123' }));

    expect(response.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('rejects a known nickname with no provisioned User row the same generic way', async () => {
    findUniqueMock.mockResolvedValue(null);

    const response = await POST(loginRequest({ nickname: 'Noel', password: 'whatever123' }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Invalid nickname or password.');
  });

  describe('first login (passwordHash is null)', () => {
    it('rejects a password shorter than 8 characters and does not create a password', async () => {
      findUniqueMock.mockResolvedValue({ id: 'user-1', nickname: 'Noel', passwordHash: null });

      const response = await POST(loginRequest({ nickname: 'Noel', password: 'short' }));

      expect(response.status).toBe(400);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('accepts an 8+ character password, hashes and saves it, and sets first/last-login audit fields', async () => {
      findUniqueMock.mockResolvedValue({ id: 'user-1', nickname: 'Noel', passwordHash: null });
      updateMock.mockResolvedValue({});

      const response = await POST(
        loginRequest(
          { nickname: 'Noel', password: 'a-new-password' },
          { 'x-forwarded-for': '203.0.113.5', 'user-agent': 'test-agent/1.0' }
        )
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true, nickname: 'Noel', firstLogin: true });

      const updateCall = updateMock.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'user-1' });
      expect(updateCall.data.passwordHash).not.toBe('a-new-password');
      expect(updateCall.data.firstLoginIp).toBe('203.0.113.5');
      expect(updateCall.data.lastLoginIp).toBe('203.0.113.5');
      expect(updateCall.data.firstLoginAt).toEqual(updateCall.data.lastLoginAt);
    });

    it('sets a session cookie that verifies to the correct userId/nickname', async () => {
      findUniqueMock.mockResolvedValue({ id: 'user-1', nickname: 'Noel', passwordHash: null });
      updateMock.mockResolvedValue({});

      const response = await POST(loginRequest({ nickname: 'Noel', password: 'a-new-password' }));

      const cookie = response.cookies.get(SESSION_COOKIE_NAME);
      expect(cookie).toBeDefined();
      expect(cookie?.httpOnly).toBe(true);
      await expect(verifySessionToken(cookie?.value)).resolves.toEqual({ userId: 'user-1', nickname: 'Noel' });
    });

    it('never echoes the submitted password back in the response body', async () => {
      findUniqueMock.mockResolvedValue({ id: 'user-1', nickname: 'Noel', passwordHash: null });
      updateMock.mockResolvedValue({});

      const response = await POST(loginRequest({ nickname: 'Noel', password: 'a-new-password' }));
      const body = await response.json();

      expect(JSON.stringify(body)).not.toContain('a-new-password');
    });
  });

  describe('returning login (passwordHash already set)', () => {
    it('rejects an incorrect password with 401 and sets no session cookie', async () => {
      const passwordHash = await hashPassword('the-real-password');
      findUniqueMock.mockResolvedValue({ id: 'user-1', nickname: 'Noel', passwordHash });

      const response = await POST(loginRequest({ nickname: 'Noel', password: 'wrong-password' }));

      expect(response.status).toBe(401);
      expect(response.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('accepts the correct password, updates only last-login fields, and sets a valid session cookie', async () => {
      const passwordHash = await hashPassword('the-real-password');
      findUniqueMock.mockResolvedValue({ id: 'user-1', nickname: 'EvilWithin', passwordHash });
      updateMock.mockResolvedValue({});

      const response = await POST(loginRequest({ nickname: 'EvilWithin', password: 'the-real-password' }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true, nickname: 'EvilWithin', firstLogin: false });

      const updateCall = updateMock.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('passwordHash');
      expect(updateCall.data).not.toHaveProperty('firstLoginAt');

      const cookie = response.cookies.get(SESSION_COOKIE_NAME);
      await expect(verifySessionToken(cookie?.value)).resolves.toEqual({
        userId: 'user-1',
        nickname: 'EvilWithin',
      });
    });

    it('never echoes the submitted password back in the error response body', async () => {
      const passwordHash = await hashPassword('the-real-password');
      findUniqueMock.mockResolvedValue({ id: 'user-1', nickname: 'Noel', passwordHash });

      const response = await POST(loginRequest({ nickname: 'Noel', password: 'wrong-password' }));
      const body = await response.json();

      expect(JSON.stringify(body)).not.toContain('wrong-password');
    });
  });
});
