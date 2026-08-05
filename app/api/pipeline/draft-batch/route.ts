import { NextResponse } from 'next/server';

import { draftBatch, humanizeBatch } from '@/features/drafting/drafting.service';

/**
 * Dashboard-triggered counterpart to the draft-batch cron work: drafts a
 * bounded batch of `enriched` prospects, then runs the humanizer pass over
 * any drafted prospects still missing a humanized variant-1 body.
 * Session-gated by `proxy.ts`, no `x-cron-secret` check — same pattern as
 * `api/pipeline/discover`.
 */
export async function POST(): Promise<NextResponse> {
  const drafted = await draftBatch();
  const humanized = await humanizeBatch();
  return NextResponse.json({ drafted, humanized });
}
