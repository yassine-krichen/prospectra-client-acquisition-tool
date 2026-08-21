import { NextRequest, NextResponse } from 'next/server';

import { isAuthorizedByCronHeader } from '@/common/auth/cron-auth';
import { runFollowupScheduler } from '@/features/followups/followup-scheduler';

/**
 * Batch endpoint for Stage 4 follow-ups, meant to be triggered on a
 * schedule: finds prospects due for their next follow-up touch (or due to be
 * marked `dead`) and processes a bounded batch of them -
 * `runFollowupScheduler`'s `FOLLOWUP_BATCH_SIZE` - re-checking the same
 * daily send cap every send path in this app respects.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronHeader(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const results = await runFollowupScheduler();
  return NextResponse.json({ results });
}
