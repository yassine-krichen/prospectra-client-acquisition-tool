import { NextRequest, NextResponse } from 'next/server';

import { env } from '@/common/config/env';
import { sha256Hex, timingSafeEqual } from '@/common/auth/session';
import { runRetentionScheduler } from '@/features/retention/retention-scheduler';

const CRON_SECRET_HEADER = 'x-cron-secret';

// Fail closed, same pattern as the discovery/draft-batch/followups cron
// routes: hash both sides to a fixed-length digest before the constant-time
// compare, since timingSafeEqual's early length check would otherwise leak
// the secret's length for variable-length inputs.
async function isAuthorized(request: NextRequest): Promise<boolean> {
  const provided = request.headers.get(CRON_SECRET_HEADER);
  if (!provided) return false;

  const [providedHash, expectedHash] = await Promise.all([sha256Hex(provided), sha256Hex(env.CRON_SECRET)]);

  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Batch endpoint for Phase 8 retention touches, meant to be triggered on a
 * schedule: finds Jobs due for their next retention touch and processes a
 * bounded batch of them - `runRetentionScheduler`'s `RETENTION_BATCH_SIZE` -
 * re-checking the same daily send cap every send path in this app respects.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const results = await runRetentionScheduler();
  return NextResponse.json({ results });
}
