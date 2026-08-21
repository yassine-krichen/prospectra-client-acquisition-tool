import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { applyServiceMatching } from '@/features/matching/matching.service';

const bodySchema = z.object({ ids: z.array(z.string()).min(1) });

export interface BulkMatchResult {
  id: string;
  ok: boolean;
  reason?: string;
}

/**
 * Bulk counterpart to `POST /api/prospects/[id]/match` - recomputes and
 * persists service suggestions for every id in the request, one at a time,
 * reusing the same rules-based matching engine the single-id route calls.
 * No external paid API involved, but sequential for consistency with the
 * other bulk routes and to keep DB write load predictable.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Request body must be { ids: string[] }.' }, { status: 400 });
  }

  const results: BulkMatchResult[] = [];
  for (const id of parsed.data.ids) {
    const result = await applyServiceMatching(id);
    switch (result.outcome) {
      case 'applied':
        results.push({ id, ok: true });
        break;
      case 'not_found':
        results.push({ id, ok: false, reason: 'Prospect not found.' });
        break;
      case 'invalid_signal':
        results.push({ id, ok: false, reason: result.reason });
        break;
    }
  }

  return NextResponse.json({ results });
}
