import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { convertProspectToClient } from '@/features/prospects/convert-to-client.service';

const bodySchema = z.object({ ids: z.array(z.string()).min(1) });

export interface BulkWinResult {
  id: string;
  ok: boolean;
  reason?: string;
  clientId?: string;
}

/**
 * Bulk counterpart to `POST /api/prospects/[id]/win` - converts every id in
 * the request into a Client, one at a time, reusing the exact same
 * `convertProspectToClient` the single-id route calls (including its
 * already-converted/do-not-contact handling).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Request body must be { ids: string[] }.' }, { status: 400 });
  }

  const results: BulkWinResult[] = [];
  for (const id of parsed.data.ids) {
    const result = await convertProspectToClient(id);
    switch (result.outcome) {
      case 'converted':
      case 'already_converted':
        results.push({ id, ok: true, clientId: result.clientId });
        break;
      case 'not_found':
        results.push({ id, ok: false, reason: 'Prospect not found.' });
        break;
      case 'blocked_do_not_contact':
        results.push({ id, ok: false, reason: 'Prospect is marked do-not-contact.' });
        break;
    }
  }

  return NextResponse.json({ results });
}
