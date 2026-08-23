import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/common/db/client';
import { getClientIp, parseUserAgent } from '@/common/auth/request-metadata';
import { hashPassword, verifyPassword } from '@/common/auth/password-hash';
import {
  createSessionToken,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from '@/common/auth/session';
import { isKnownUsername } from '@/features/auth/known-usernames';

const MIN_PASSWORD_LENGTH = 8;

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
 * Handles both login and first-time password setup for one of the two
 * fixed accounts (Noel / EvilWithin - see known-usernames.ts). There is no
 * registration path: `nickname` must already be one of those two AND
 * already exist as a `User` row (provisioned by
 * app/api/cron/seed-users/route.ts) - anything else is rejected the same
 * generic way a wrong password would be, so this never confirms/denies
 * which nicknames exist.
 *
 * A `User` row with `passwordHash === null` hasn't completed setup yet:
 * the submitted password becomes that account's permanent password
 * (min 8 chars) instead of being checked against anything. This is the
 * *only* place a password ever gets set - there is no separate signup
 * endpoint.
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

  const user = await prisma.user.findUnique({ where: { nickname } });
  if (!user) {
    return NextResponse.json({ error: 'Invalid nickname or password.' }, { status: 401 });
  }

  const ip = getClientIp(request);
  const userAgent = request.headers.get('user-agent');
  const { browser, device } = parseUserAgent(userAgent);
  const now = new Date();

  if (user.passwordHash === null) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(password);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        firstLoginAt: now,
        firstLoginIp: ip,
        firstLoginUserAgent: userAgent,
        firstLoginDevice: device,
        firstLoginBrowser: browser,
        lastLoginAt: now,
        lastLoginIp: ip,
        lastLoginUserAgent: userAgent,
        lastLoginDevice: device,
        lastLoginBrowser: browser,
      },
    });

    const token = await createSessionToken({ userId: user.id, nickname: user.nickname });
    return withSessionCookie(NextResponse.json({ ok: true, nickname: user.nickname, firstLogin: true }), token);
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
  }

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
  return withSessionCookie(NextResponse.json({ ok: true, nickname: user.nickname, firstLogin: false }), token);
}
