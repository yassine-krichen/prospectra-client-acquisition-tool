import { NextRequest, NextResponse } from 'next/server';

import { enrichProspect } from '@/features/enrichment/enrichment.service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Runs the Branch C contact-enrichment fallback chain (Hunter -> People
 * Data Labs -> pattern-guess+MX-check) against a single existing prospect,
 * persists whichever result was found, and returns the updated prospect
 * alongside a summary of which sources ran/were used.
 */
export async function POST(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const result = await enrichProspect(id);
  if (!result) {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  return NextResponse.json(result);
}
