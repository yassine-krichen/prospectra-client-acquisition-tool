import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/common/db/client';

const bodySchema = z.object({
  ids: z.array(z.string()).min(1),
  favorite: z.boolean(),
});

export interface BulkFavoriteResult {
  id: string;
  ok: boolean;
}

/**
 * Bulk counterpart to `PATCH /api/prospects/[id]/favorite` - toggles the same
 * dashboard-only `favorite` pin marker (see the doc comment on
 * `Prospect.favorite` in prisma/schema.prisma) for every id in the request,
 * one at a time, reusing the exact same `updateMany`-per-id semantics as the
 * single-id route: a missing id is a normal "0 rows touched" outcome, not a
 * thrown error.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Request body must be { ids: string[], favorite: boolean }.' },
      { status: 400 }
    );
  }

  const results: BulkFavoriteResult[] = [];
  for (const id of parsed.data.ids) {
    const { count } = await prisma.prospect.updateMany({
      where: { id },
      data: { favorite: parsed.data.favorite },
    });
    results.push({ id, ok: count > 0 });
  }

  return NextResponse.json({ results });
}
