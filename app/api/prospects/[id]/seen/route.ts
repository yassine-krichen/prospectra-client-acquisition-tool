import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/common/db/client';

interface RouteParams {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({ seen: z.boolean() });

/**
 * Toggles a Prospect's `seen` flag - a dashboard-only read marker (see the
 * doc comment on `Prospect.seen` in prisma/schema.prisma), not part of the
 * outreach pipeline's own state. `updateMany` (rather than `update`) so a
 * missing id is a normal "0 rows touched" outcome instead of a thrown
 * `PrismaClientKnownRequestError`, matching this app's "never throw across
 * an API boundary" convention.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: '"seen" must be a boolean.' }, { status: 400 });
  }

  const { count } = await prisma.prospect.updateMany({
    where: { id },
    data: { seen: parsed.data.seen },
  });

  if (count === 0) {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  return NextResponse.json({ id, seen: parsed.data.seen });
}
