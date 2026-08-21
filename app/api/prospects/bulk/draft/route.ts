import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { draftProspect } from '@/features/drafting/drafting.service';

const bodySchema = z.object({ ids: z.array(z.string()).min(1) });

export interface BulkDraftResult {
  id: string;
  ok: boolean;
  reason?: string;
}

/**
 * Bulk counterpart to `POST /api/prospects/[id]/draft` - runs the exact same
 * per-prospect drafting flow (LLM routing, exactly 3 variants, humanizer)
 * for every id in the request, one at a time (not `Promise.all`), since each
 * call is a real AI draft-generation request against a rate-limited LLM
 * provider.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Request body must be { ids: string[] }.' }, { status: 400 });
  }

  const results: BulkDraftResult[] = [];
  for (const id of parsed.data.ids) {
    const result = await draftProspect(id);
    if (!result) {
      results.push({ id, ok: false, reason: 'Prospect not found.' });
    } else if (result.ok) {
      results.push({ id, ok: true });
    } else {
      results.push({ id, ok: false, reason: result.message });
    }
  }

  return NextResponse.json({ results });
}
