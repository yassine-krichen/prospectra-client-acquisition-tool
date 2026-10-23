import { NextRequest, NextResponse } from 'next/server';

import { resolveUnconfirmedSend } from '@/features/sending/resolve-unconfirmed-send.service';
import { resolveUnconfirmedRequestSchema } from '@/features/sending/sending.types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Settles a send whose delivery was unconfirmed, after a human has checked
 * the provider dashboard. 404 for an unknown prospect; 200 with
 * `nothing_to_resolve` when there is no (longer any) unconfirmed send.
 */
export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const body: unknown = await request.json().catch(() => null);
  const parsed = resolveUnconfirmedRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: '"outcome" must be "delivered" or "not_delivered".' }, { status: 400 });
  }

  const result = await resolveUnconfirmedSend(id, parsed.data.outcome);
  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  return NextResponse.json(result);
}
