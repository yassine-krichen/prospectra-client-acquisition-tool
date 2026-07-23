import { NextRequest, NextResponse } from 'next/server';

import { SESSION_COOKIE_NAME, verifySessionToken } from '@/common/auth/session';

// Deny by default: everything except the login route, its API, Next's
// static/internal assets, and the Resend inbound webhook requires a valid
// session. The webhook exclusion is anchored to the exact path segment
// (`api/webhooks/resend(?:/|$)`), same as `login`/`api/login` above, so it
// can never accidentally match something like `/api/webhooks/resend-fake`.
// That route is not left open to the world, though — it verifies Resend's
// own webhook signature instead of a session cookie (see
// verify-resend-signature.ts), since it must accept POSTs from Resend's
// servers, which will never have a dashboard session cookie.
export const config = {
  matcher: ['/((?!login(?:/|$)|api/login(?:/|$)|api/webhooks/resend(?:/|$)|_next/|favicon\\.ico$).*)'],
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
