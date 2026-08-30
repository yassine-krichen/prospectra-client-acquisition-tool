import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { enrichProspect } from '@/features/enrichment/enrichment.service';

// Max 100 matches this app's own largest selectable page size
// (`pageSizeOptions` in data-table-pagination.tsx / the API's own `limit`
// cap in app/api/prospects/route.ts) - a human can never select more than
// that many rows via the dashboard's checkboxes in one page, so this just
// closes off a request crafted (by bug or otherwise) to bypass that natural
// ceiling and burn unbounded paid-enrichment-API cost.
const bodySchema = z.object({ ids: z.array(z.string()).min(1).max(100) });

export interface BulkEnrichResult {
  id: string;
  ok: boolean;
  reason?: string;
}

/**
 * Bulk counterpart to `POST /api/prospects/[id]/enrich` - runs the exact
 * same per-prospect enrichment fallback chain for every id in the request,
 * one at a time (not `Promise.all`). Hunter and People Data Labs are
 * external, rate-limited APIs (and Hunter is additionally hard-capped at
 * `MONTHLY_FREE_TIER_CAP` in `hunter.source.ts`) - running a large
 * selection sequentially avoids bursting them any harder than a human
 * clicking "Enrich" on each row individually already would.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Request body must be { ids: string[] }.' }, { status: 400 });
  }

  const results: BulkEnrichResult[] = [];
  for (const id of parsed.data.ids) {
    const result = await enrichProspect(id);
    results.push(result ? { id, ok: true } : { id, ok: false, reason: 'Prospect not found.' });
  }

  return NextResponse.json({ results });
}
