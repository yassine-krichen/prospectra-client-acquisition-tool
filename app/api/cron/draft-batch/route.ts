import { NextRequest, NextResponse } from 'next/server';

import { isAuthorizedByCronHeader } from '@/common/auth/cron-auth';
import { draftBatch, humanizeBatch } from '@/features/drafting/drafting.service';

/**
 * Batch endpoint for Stage 2 drafting, meant to be triggered on a schedule:
 * (a) drafts a bounded batch of `enriched`-status prospects
 * (`draftBatch`/`DRAFT_BATCH_SIZE`), then (b) separately runs the humanizer
 * pass for previously-drafted, non-high-priority prospects that don't yet
 * have a `humanizedBody` (`humanizeBatch`/`HUMANIZE_BATCH_SIZE`). Part (b)'s
 * batch size is deliberately small - see `drafting.service.ts`'s doc
 * comment on `HUMANIZE_BATCH_SIZE` - since claude-bridge's real ~40
 * messages/8-hour limit is shared across every caller, including whatever
 * this cron's own part (a) just humanized inline for high-priority
 * prospects, and across however many times this cron runs before that
 * window resets.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronHeader(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const drafted = await draftBatch();
  const humanized = await humanizeBatch();

  return NextResponse.json({ drafted, humanized });
}
