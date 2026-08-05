import { NextResponse } from 'next/server';

import { runFollowupScheduler } from '@/features/followups/followup-scheduler';

/**
 * Dashboard-triggered counterpart to `api/cron/followups`. Session-gated by
 * `proxy.ts`, no `x-cron-secret` check — same pattern as
 * `api/pipeline/discover`.
 */
export async function POST(): Promise<NextResponse> {
  const results = await runFollowupScheduler();
  return NextResponse.json({ results });
}
