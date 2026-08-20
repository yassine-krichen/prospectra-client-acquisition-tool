import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/common/db/client';
import { markJobDelivered } from '@/features/retention/retention-job-status.service';

interface RouteParams {
  params: Promise<{ clientId: string; jobId: string }>;
}

/**
 * Marks a one-off Job `active -> delivered` (see `markJobDelivered`).
 * Verifies the Job actually belongs to `clientId` from the route - not just
 * that the Job exists - before delegating, since `jobId` alone would
 * otherwise let a caller deliver a Job under the wrong Client's URL. Returns
 * 200 with the outcome in the body for every "can't do this right now" case
 * (`already_delivered`, `not_eligible`), matching this app's established
 * per-item-outcome convention (`prospects/[id]/win/route.ts`) rather than
 * encoding those as HTTP error statuses. Only a genuinely missing/mismatched
 * Job is a 404.
 */
export async function POST(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { clientId, jobId } = await params;

  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
  if (!job || job.clientId !== clientId) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  const result = await markJobDelivered(jobId);

  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }

  if (result.outcome === 'delivered') {
    return NextResponse.json({
      outcome: result.outcome,
      deliveredAt: result.deliveredAt,
      freeRevisionWindowEndsAt: result.freeRevisionWindowEndsAt,
    });
  }

  return NextResponse.json({ outcome: result.outcome });
}
