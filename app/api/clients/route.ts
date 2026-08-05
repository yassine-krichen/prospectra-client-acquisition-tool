import { NextResponse } from 'next/server';

import { listClients } from '@/features/clients/clients.repository';

/** Lists every Client with its Jobs, newest first — backs the dashboard Clients table. */
export async function GET(): Promise<NextResponse> {
  const clients = await listClients();
  return NextResponse.json({ clients });
}
