import { NextRequest, NextResponse } from 'next/server';

import { isAuthorizedByCronHeader } from '@/common/auth/cron-auth';
import { runRetentionScheduler } from '@/features/retention/retention-scheduler';

/**
 * Batch endpoint for Phase 8 retention touches, meant to be triggered on a
 * schedule: finds Jobs due for their next retention touch and processes a
 * bounded batch of them - `runRetentionScheduler`'s `RETENTION_BATCH_SIZE` -
 * re-checking the same daily send cap every send path in this app respects.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronHeader(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const results = await runRetentionScheduler();
  return NextResponse.json({ results });
}
