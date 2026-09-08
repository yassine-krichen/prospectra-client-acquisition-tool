import { NextResponse } from 'next/server';

import { listDistinctReasons } from '@/features/prospects/prospects.repository';

// Backs the "Reason contains" filter's combobox on `/prospects` - session
// gated only, like `GET /api/prospects` itself (proxy.ts handles auth).
export async function GET(): Promise<NextResponse> {
  const reasons = await listDistinctReasons();
  return NextResponse.json({ reasons });
}
