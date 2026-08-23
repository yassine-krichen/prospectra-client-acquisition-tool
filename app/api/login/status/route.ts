import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/common/db/client';
import { isKnownUsername } from '@/features/auth/known-usernames';

/**
 * Tells the login page which password prompt to show for a nickname the
 * user just picked from the combobox - "set your password" (first login)
 * vs. "enter your password" (returning) - without a full login attempt.
 * Doesn't leak anything beyond that boolean: an unknown/not-yet-provisioned
 * nickname reports `needsSetup: true` too, same as a real account that
 * hasn't set a password yet, since both cases show the identical prompt.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const nickname = request.nextUrl.searchParams.get('nickname');

  if (!nickname || !isKnownUsername(nickname)) {
    return NextResponse.json({ error: 'Unknown nickname.' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { nickname }, select: { passwordHash: true } });
  return NextResponse.json({ needsSetup: !user || user.passwordHash === null });
}
