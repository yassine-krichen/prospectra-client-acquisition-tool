import { NextResponse } from 'next/server';

import { SESSION_COOKIE_NAME } from '@/common/auth/session';

/**
 * Clears the dashboard session cookie. There is no server-side session store
 * to invalidate (the cookie is a self-verifying signed token) - logging out
 * just means the browser stops sending it.
 */
export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });

  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}
