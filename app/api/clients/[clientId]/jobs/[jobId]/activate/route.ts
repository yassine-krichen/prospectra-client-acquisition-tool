import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/common/db/client';
import { markJobRecurringActive } from '@/features/retention/retention-job-status.service';

interface RouteParams {
  params: Promise<{ clientId: string; jobId: string }>;
}

/**
 * Marks a recurring Job `active -> monthly` (see `markJobRecurringActive`) —
 * the retainer "going live" for the first time. Verifies the Job actually
 * belongs to `clientId` from the route — not just that the Job exists —
 * before delegating, same ownership check as the sibling `deliver` route.
 * Returns 200 with the outcome in the body for every "can't do this right
 * now" case (`already_active`, `not_eligible`), matching this app's
 * established per-item-outcome convention. Only a genuinely missing/
 * mismatched Job is a 404.
 */
export async function POST(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { clientId, jobId } = await params;

  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
  if (!job || job.clientId !== clientId) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  const result = await markJobRecurringActive(jobId);

  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  return NextResponse.json({ outcome: result.outcome });
}
