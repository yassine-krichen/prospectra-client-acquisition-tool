import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { env } from '@/common/config/env';
import {
  createSessionToken,
  sha256Hex,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  timingSafeEqual,
} from '@/common/auth/session';

const loginRequestSchema = z.object({
  password: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = loginRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Password is required.' }, { status: 400 });
  }

  // Fail closed: only an exact match grants a session. Hash both sides to a
  // fixed-length digest before comparing so the constant-time compare below
  // doesn't leak the password's length via its early length check.
  const [submittedHash, expectedHash] = await Promise.all([
    sha256Hex(parsed.data.password),
    sha256Hex(env.DASHBOARD_PASSWORD),
  ]);

  if (!timingSafeEqual(submittedHash, expectedHash)) {
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  const token = await createSessionToken();
  const response = NextResponse.json({ ok: true });

  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return response;
}
