import { NextRequest, NextResponse } from 'next/server';

import { isAuthorizedByCronBearer } from '@/common/auth/cron-auth';
import { draftBatch, humanizeBatch } from '@/features/drafting/drafting.service';
import { runFollowupScheduler } from '@/features/followups/followup-scheduler';
import { runRetentionScheduler } from '@/features/retention/retention-scheduler';

// Vercel's Hobby plan caps Cron Jobs to a small fixed count at once-a-day
// frequency, so stages 2 (drafting), 4 (follow-ups), and 8 (retention) are
// bundled into a single scheduled route (see vercel.json) instead of one
// cron job each - the discover route's GET handler is the only other one.
// Each stage below is independently bounded (DRAFT_BATCH_SIZE,
// HUMANIZE_BATCH_SIZE, FOLLOWUP_BATCH_SIZE, RETENTION_BATCH_SIZE) and
// follow-ups/retention re-check the shared daily send cap themselves, so
// running them back to back once a day is safe.
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronBearer(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const drafted = await draftBatch();
  const humanized = await humanizeBatch();
  const followups = await runFollowupScheduler();
  const retention = await runRetentionScheduler();

  return NextResponse.json({ drafted, humanized, followups, retention });
}
