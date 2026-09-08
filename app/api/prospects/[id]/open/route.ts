import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/common/db/client';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/common/auth/session';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Records that a human opened this prospect's detail dialog - the "Opened"
 * column's `lastOpenedAt`/`lastOpenedByNickname` (see the doc comment on
 * `Prospect.lastOpenedAt` in prisma/schema.prisma). Tracks the most recent
 * open only, not a full history, and only ever moves forward - there's no
 * way to un-open a prospect.
 *
 * `lastOpenedByNickname` comes from the session cookie, not the request
 * body - proxy.ts already requires a valid session for every non-exempt
 * route, but this handler verifies it directly rather than trusting a
 * client-supplied identity, same posture as every other place in this app
 * that needs to know who's signed in.
 */
export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const lastOpenedAt = new Date();

  const { count } = await prisma.prospect.updateMany({
    where: { id },
    data: { lastOpenedAt, lastOpenedByNickname: session.nickname },
  });

  if (count === 0) {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  return NextResponse.json({ id, lastOpenedAt, lastOpenedByNickname: session.nickname });
}
