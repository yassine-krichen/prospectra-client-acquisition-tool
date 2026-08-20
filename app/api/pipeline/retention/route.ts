import { NextResponse } from 'next/server';

import { runRetentionScheduler } from '@/features/retention/retention-scheduler';

/**
 * Dashboard-triggered counterpart to `api/cron/retention`. Session-gated by
 * `proxy.ts`, no `x-cron-secret` check - same pattern as
 * `api/pipeline/discover`.
 */
export async function POST(): Promise<NextResponse> {
  const results = await runRetentionScheduler();
  return NextResponse.json({ results });
}
