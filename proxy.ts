import { NextRequest, NextResponse } from 'next/server';

import { SESSION_COOKIE_NAME, verifySessionToken } from '@/common/auth/session';

// Deny by default: everything except the login route, its API, and Next's
// static/internal assets requires a valid session.
export const config = {
  matcher: ['/((?!login(?:/|$)|api/login(?:/|$)|_next/|favicon\\.ico$).*)'],
};

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const isAuthenticated = await verifySessionToken(token);

  if (!isAuthenticated) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}
