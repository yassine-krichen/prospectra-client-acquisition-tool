import { NextRequest, NextResponse } from 'next/server';

import { approveDrafts } from '@/features/sending/send-queue.service';
import { approvalBatchRequestSchema } from '@/features/sending/sending.types';

/**
 * The one HTTP entry point capable of actually sending an email - reached
 * only by a human clicking "approve" (single or bulk) in the queue UI. Runs
 * `approveDrafts`, which itself is the one function allowed to call
 * `sendEmail`; every safety check (do-not-contact, daily cap, domain
 * verification gate) lives there, not here.
 *
 * Returns 200 with one outcome per requested draft - `sent`, `failed`,
 * `skipped_cap`, `skipped_do_not_contact`, `skipped_already_approved`, or
 * `not_found` - rather than a single pass/fail, since a batch can partially
 * succeed and a human needs to know exactly which items actually went out.
 * A request naming the same `draftId` more than once is rejected outright
 * with 400 (see `approvalBatchRequestSchema`), fail closed, rather than
 * silently collapsed or processed more than once.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = approvalBatchRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body.', issues: parsed.error.issues }, { status: 400 });
  }

  const results = await approveDrafts(parsed.data.approvals);
  return NextResponse.json({ results });
}
