import { NextResponse } from 'next/server';

import { listApprovalQueue } from '@/features/sending/queue-listing';

/**
 * Lists every `drafted`-status prospect for the approval queue UI, each with
 * its chosen display draft (see `pickDisplayDraft` in queue-listing.ts) and
 * the current daily-cap status, so the UI can show why an approval might be
 * blocked before a human even clicks approve.
 */
export async function GET(): Promise<NextResponse> {
  const result = await listApprovalQueue();
  return NextResponse.json(result);
}
