import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { isAuthorizedByCronHeader } from '@/common/auth/cron-auth';
import { prisma } from '@/common/db/client';
import { hashPassword, MIN_PASSWORD_LENGTH } from '@/common/auth/password-hash';
import { KNOWN_USERNAMES } from '@/features/auth/known-usernames';

const seedUsersRequestSchema = z.object({
  passwords: z.record(z.string(), z.string()).optional(),
});

type SeedResult = { nickname: string; created: boolean; error?: string };

/**
 * One-time (idempotent) bootstrap for the two fixed accounts - there is no
 * public registration endpoint, so this is how Noel/EvilWithin's `User`
 * rows come to exist at all. Safe to call repeatedly (e.g. after every
 * deploy): only ever creates a missing row, never touches a row that
 * already exists - in particular, it can never overwrite a password
 * someone already set.
 *
 * Creating a not-yet-existing account now *requires* a password up front,
 * passed in the request body as `{ passwords: { <nickname>: '...' } }`
 * (min MIN_PASSWORD_LENGTH characters) - this route used to create accounts
 * with `passwordHash: null` and let whoever logged in first claim the
 * account, which was a real vulnerability (fixed here). A nickname missing
 * a valid password in the body is simply skipped (not created) and reported
 * as an error in its own per-nickname result; other nicknames in the same
 * call still process normally. Manual/ad-hoc triggering only (same
 * `x-cron-secret` auth as the other app/api/cron/* routes) - this isn't
 * meant to run on the daily Vercel Cron schedule (vercel.json), there's
 * nothing to repeat once both accounts exist.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronHeader(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = seedUsersRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const passwords = parsed.data.passwords ?? {};
  const results: SeedResult[] = [];

  for (const nickname of KNOWN_USERNAMES) {
    const existing = await prisma.user.findUnique({ where: { nickname }, select: { id: true } });
    if (existing) {
      results.push({ nickname, created: false });
      continue;
    }

    const password = passwords[nickname];
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      results.push({
        nickname,
        created: false,
        error: `password required (min ${MIN_PASSWORD_LENGTH} characters)`,
      });
      continue;
    }

    const passwordHash = await hashPassword(password);
    await prisma.user.create({ data: { nickname, passwordHash } });
    results.push({ nickname, created: true });
  }

  return NextResponse.json({ results });
}
