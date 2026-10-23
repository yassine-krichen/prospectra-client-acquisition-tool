import { NextResponse } from 'next/server';

import { listFollowupQueue } from '@/features/followups/followup-approval.service';

/**
 * Follow-ups waiting for a human (with the exact email each would send),
 * follow-ups whose send outcome is unconfirmed, and whether approval is
 * currently required. Session-gated by proxy.ts like every non-excluded route.
 */
export async function GET(): Promise<NextResponse> {
  const result = await listFollowupQueue();
  return NextResponse.json(result);
}
