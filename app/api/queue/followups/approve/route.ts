import { NextRequest, NextResponse } from 'next/server';

import { approveFollowups } from '@/features/followups/followup-approval.service';
import { approveFollowupsRequestSchema } from '@/features/followups/followup-approval.types';

/**
 * Human-initiated send of follow-ups (touch 2). Returns 200 with one outcome
 * per requested prospect - `sent`, `failed`, `skipped_cap` or
 * `skipped_not_eligible` - since a batch can partially succeed. A request
 * naming the same prospect twice is rejected with 400, fail closed.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = approveFollowupsRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body.', issues: parsed.error.issues }, { status: 400 });
  }

  const results = await approveFollowups(parsed.data.prospectIds);
  return NextResponse.json({ results });
}
