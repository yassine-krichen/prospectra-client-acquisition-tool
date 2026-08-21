import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/common/db/client';

const bodySchema = z.object({
  ids: z.array(z.string()).min(1),
  seen: z.boolean(),
});

export interface BulkSeenResult {
  id: string;
  ok: boolean;
}

/**
 * Bulk counterpart to `PATCH /api/prospects/[id]/seen` - toggles the same
 * dashboard-only `seen` read marker (see the doc comment on `Prospect.seen`
 * in prisma/schema.prisma) for every id in the request, one at a time,
 * reusing the exact same `updateMany`-per-id semantics as the single-id
 * route: a missing id is a normal "0 rows touched" outcome, not a thrown
 * error.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Request body must be { ids: string[], seen: boolean }.' }, { status: 400 });
  }

  const results: BulkSeenResult[] = [];
  for (const id of parsed.data.ids) {
    const { count } = await prisma.prospect.updateMany({
      where: { id },
      data: { seen: parsed.data.seen },
    });
    results.push({ id, ok: count > 0 });
  }

  return NextResponse.json({ results });
}
