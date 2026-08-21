import { NextRequest, NextResponse } from 'next/server';

import { convertProspectToClient } from '@/features/prospects/convert-to-client.service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Marks a Prospect as won and converts it into a Client (see
 * `convertProspectToClient`). Returns 200 with the outcome in the body for
 * every "can't do this right now" case - `already_converted`,
 * `blocked_do_not_contact` - matching this app's established per-item-
 * outcome convention (`queue/approve/route.ts`) rather than encoding those
 * as HTTP error statuses. Only a genuinely missing Prospect is a 404.
 */
export async function POST(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const result = await convertProspectToClient(id);

  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  if (result.outcome === 'converted' || result.outcome === 'already_converted') {
    return NextResponse.json({ outcome: result.outcome, clientId: result.clientId });
  }

  return NextResponse.json({ outcome: result.outcome });
}
