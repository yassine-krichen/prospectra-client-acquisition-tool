import { NextRequest, NextResponse } from 'next/server';

import { getProspectById } from '@/features/prospects/prospects.repository';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Full-detail fetch for the prospect detail dialog - every column plus
 * drafts, unlike the trimmed `ProspectListItem` shape `GET /api/prospects`
 * returns. Session-gated via proxy.ts like every other dashboard route.
 */
export async function GET(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const prospect = await getProspectById(id);

  if (!prospect) {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  return NextResponse.json(prospect);
}
