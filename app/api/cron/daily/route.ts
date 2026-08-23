import { NextRequest, NextResponse } from 'next/server';

import { isAuthorizedByCronBearer } from '@/common/auth/cron-auth';
import { DRAFT_BATCH_SIZE, HUMANIZE_BATCH_SIZE, draftBatch, humanizeBatch } from '@/features/drafting/drafting.service';
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

// Only auto-draft/humanize `strong` ("High") signal prospects on this fully
// unattended path - a deliberate restriction so the cron spends effort on
// the best leads only, leaving medium/weak-signal prospects for a human to
// draft manually (dashboard Pipeline page) if they judge it worthwhile. Not
// applied to follow-ups/retention: by the time a prospect reaches those
// stages a human (or this same restriction, earlier) already chose to
// draft/send it, so there's no further signal-based decision left to make.
const SIGNAL_STRENGTH_FILTER = { signalStrength: 'strong' } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronBearer(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const drafted = await draftBatch(DRAFT_BATCH_SIZE, SIGNAL_STRENGTH_FILTER);
  const humanized = await humanizeBatch(HUMANIZE_BATCH_SIZE, SIGNAL_STRENGTH_FILTER);
  const followups = await runFollowupScheduler();
  const retention = await runRetentionScheduler();

  return NextResponse.json({ drafted, humanized, followups, retention });
}
