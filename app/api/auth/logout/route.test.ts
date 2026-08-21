import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE_NAME } from '@/common/auth/session';

import { POST } from './route';

describe('POST /api/auth/logout', () => {
  it('clears the session cookie so the browser stops sending it', async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    const cookie = response.cookies.get(SESSION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });
});
