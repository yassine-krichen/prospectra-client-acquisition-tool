import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { deleteProspect } from '@/features/prospects/prospects.repository';

const bodySchema = z.object({ ids: z.array(z.string()).min(1) });

export interface BulkDeleteResult {
  id: string;
  ok: boolean;
  reason?: string;
}

/**
 * Bulk counterpart to `DELETE /api/prospects/[id]` - permanently deletes
 * every id in the request, one at a time, reusing the exact same
 * `deleteProspect` the single-id route calls (including its do-not-contact
 * block). A DNC id in the batch is skipped with its own `ok: false` result
 * (same as a missing id) - it does NOT block the rest of the batch from
 * deleting. POST (not DELETE) since this is a one-shot destructive action
 * with a JSON body, same convention as bulk win, not an idempotent toggle
 * like bulk seen.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Request body must be { ids: string[] }.' }, { status: 400 });
  }

  const results: BulkDeleteResult[] = [];
  for (const id of parsed.data.ids) {
    const result = await deleteProspect(id);
    switch (result.outcome) {
      case 'deleted':
        results.push({ id, ok: true });
        break;
      case 'not_found':
        results.push({ id, ok: false, reason: 'Prospect not found.' });
        break;
      case 'blocked_do_not_contact':
        results.push({ id, ok: false, reason: 'Cannot delete a do-not-contact prospect.' });
        break;
    }
  }

  return NextResponse.json({ results });
}
