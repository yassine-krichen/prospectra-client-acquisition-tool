import { NextRequest, NextResponse } from 'next/server';

import { createJobRequestSchema } from '@/features/clients/client.types';
import { createJob } from '@/features/clients/create-job.service';

interface RouteParams {
  params: Promise<{ clientId: string }>;
}

/**
 * Records a sold service against a Client - the one write path for `Job`
 * creation (see `createJob`'s doc comment for why this route exists). Body
 * shape is validated here (controller boundary); the cross-field
 * `retainerDiscount`/`service` rule is a business rule, validated in the
 * service layer instead.
 */
export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { clientId } = await params;

  const body: unknown = await request.json().catch(() => null);
  const parsed = createJobRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body.', issues: parsed.error.issues }, { status: 400 });
  }

  const result = await createJob(clientId, parsed.data);

  if (result.outcome === 'client_not_found') {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  if (result.outcome === 'invalid_input') {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }

  return NextResponse.json({ outcome: result.outcome, jobId: result.jobId }, { status: 201 });
}
