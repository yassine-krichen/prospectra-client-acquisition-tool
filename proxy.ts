import { NextRequest, NextResponse } from 'next/server';

import { SESSION_COOKIE_NAME, verifySessionToken } from '@/common/auth/session';

// Deny by default: everything except the login route, its API, Next's
// static/internal assets, the Resend inbound webhook, and the cron routes
// requires a valid session. Each exclusion is anchored to its exact path
// segment (e.g. `api/webhooks/resend(?:/|$)`), same as `login`/`api/login`
// above, so none can accidentally match something like
// `/api/webhooks/resend-fake`. Those routes aren't left open to the world,
// though - they verify Resend's own webhook signature / the `x-cron-secret`
// header instead of a session cookie (see verify-resend-signature.ts and
// each cron route's own `isAuthorized`), since their callers (Resend,
// Vercel Cron) will never have a dashboard session cookie to send.
export const config = {
  matcher: ['/((?!login(?:/|$)|api/login(?:/|$)|api/webhooks/resend(?:/|$)|api/cron/|_next/|favicon\\.ico$).*)'],
};

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);

  if (!session) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}
