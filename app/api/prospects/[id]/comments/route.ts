import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { SESSION_COOKIE_NAME, verifySessionToken } from '@/common/auth/session';
import { addProspectComment } from '@/features/prospects/prospects.repository';

interface RouteParams {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({ body: z.string().trim().min(1).max(2000) });

/**
 * Adds a free-text comment to a prospect - see the doc comment on
 * `ProspectComment` in prisma/schema.prisma. `authorNickname` comes from the
 * session cookie, not the request body - same posture as
 * `POST /api/prospects/[id]/open`: proxy.ts already requires a valid session
 * for every non-exempt route, but this handler verifies it directly rather
 * than trusting a client-supplied identity.
 */
export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const parsedBody: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Request body must be { body: string } (1-2000 characters).' }, { status: 400 });
  }

  const comment = await addProspectComment(id, parsed.data.body, session.nickname);
  if (!comment) {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  return NextResponse.json(comment);
}
