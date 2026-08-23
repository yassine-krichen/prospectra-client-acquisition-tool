import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/common/db/client';
import { getClientIp, parseUserAgent } from '@/common/auth/request-metadata';
import { verifyPassword } from '@/common/auth/password-hash';
import { clearLockout, isLockedOut, recordFailedAttempt } from '@/common/auth/login-lockout';
import {
  createSessionToken,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from '@/common/auth/session';
import { isKnownUsername } from '@/features/auth/known-usernames';

const loginRequestSchema = z.object({
  nickname: z.string().min(1),
  password: z.string().min(1),
});

function withSessionCookie(response: NextResponse, token: string): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

/**
 * Logs in one of the two fixed accounts (Noel / EvilWithin - see
 * known-usernames.ts). There is no registration path: `nickname` must
 * already be one of those two AND already exist as a `User` row with a
 * password set (provisioned by app/api/cron/seed-users/route.ts, which now
 * requires a password up front) - anything else is rejected the same
 * generic way a wrong password would be, so this never confirms/denies
 * which nicknames exist or are provisioned.
 *
 * Failed attempts are tracked per-nickname (login-lockout.ts): after 5
 * failures the account is locked out for 15 minutes, reset on the next
 * successful login.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = loginRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Nickname and password are required.' }, { status: 400 });
  }

  const { nickname, password } = parsed.data;

  if (!isKnownUsername(nickname)) {
    return NextResponse.json({ error: 'Invalid nickname or password.' }, { status: 401 });
  }

  if (await isLockedOut(nickname)) {
    return NextResponse.json({ error: 'Too many attempts, try again later.' }, { status: 429 });
  }

  const user = await prisma.user.findUnique({ where: { nickname } });
  if (!user) {
    return NextResponse.json({ error: 'Invalid nickname or password.' }, { status: 401 });
  }

  // Shouldn't happen post-provisioning-fix (seed-users now requires a
  // password up front), but fail closed rather than throw if it ever does.
  if (!user.passwordHash) {
    return NextResponse.json({ error: 'Invalid nickname or password.' }, { status: 401 });
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    await recordFailedAttempt(nickname);
    return NextResponse.json({ error: 'Invalid nickname or password.' }, { status: 401 });
  }

  const ip = getClientIp(request);
  const userAgent = request.headers.get('user-agent');
  const { browser, device } = parseUserAgent(userAgent);
  const now = new Date();

  await clearLockout(nickname);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: now,
      lastLoginIp: ip,
      lastLoginUserAgent: userAgent,
      lastLoginDevice: device,
      lastLoginBrowser: browser,
    },
  });

  const token = await createSessionToken({ userId: user.id, nickname: user.nickname });
  return withSessionCookie(NextResponse.json({ ok: true, nickname: user.nickname }), token);
}
