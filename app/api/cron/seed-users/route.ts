import { NextRequest, NextResponse } from 'next/server';

import { isAuthorizedByCronHeader } from '@/common/auth/cron-auth';
import { prisma } from '@/common/db/client';
import { KNOWN_USERNAMES } from '@/features/auth/known-usernames';

/**
 * One-time (idempotent) bootstrap for the two fixed accounts - there is no
 * public registration endpoint, so this is how Noel/EvilWithin's `User`
 * rows come to exist at all. Safe to call repeatedly (e.g. after every
 * deploy): only ever creates a missing row with `passwordHash: null`,
 * never touches a row that already exists - in particular, it can never
 * overwrite a password someone already set. Manual/ad-hoc triggering only
 * (same `x-cron-secret` auth as the other app/api/cron/* routes) - this
 * isn't meant to run on the daily Vercel Cron schedule (vercel.json),
 * there's nothing to repeat once both accounts exist.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronHeader(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const results: Array<{ nickname: string; created: boolean }> = [];

  for (const nickname of KNOWN_USERNAMES) {
    const existing = await prisma.user.findUnique({ where: { nickname }, select: { id: true } });
    if (existing) {
      results.push({ nickname, created: false });
      continue;
    }

    await prisma.user.create({ data: { nickname } });
    results.push({ nickname, created: true });
  }

  return NextResponse.json({ results });
}
