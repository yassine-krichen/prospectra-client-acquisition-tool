import { NextRequest, NextResponse } from 'next/server';

import { deleteProspect, getProspectById } from '@/features/prospects/prospects.repository';

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

/**
 * Permanently deletes a Prospect - a real hard delete (see the doc comment
 * on `deleteProspect` in prospects.repository.ts), not reversible. Returns
 * 200 with `{ outcome: 'blocked_do_not_contact' }` for a DNC prospect
 * (matching `win`'s own do-not-contact block - see `route.test.ts` on that
 * route for why 200, not 403, is this app's convention for "can't do this
 * right now" outcomes) rather than deleting it. Session-gated via proxy.ts
 * like every other dashboard route.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const result = await deleteProspect(id);

  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  if (result.outcome === 'blocked_do_not_contact') {
    return NextResponse.json({ outcome: result.outcome });
  }

  return NextResponse.json({ id: result.id, deleted: true });
}
