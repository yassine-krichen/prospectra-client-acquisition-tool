import { NextRequest, NextResponse } from 'next/server';

import { getClientWithJobs } from '@/features/clients/clients.repository';

interface RouteParams {
  params: Promise<{ clientId: string }>;
}

/** Single Client with its full Job history — backs the dashboard Client detail page. */
export async function GET(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { clientId } = await params;

  const client = await getClientWithJobs(clientId);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  return NextResponse.json({ client });
}
