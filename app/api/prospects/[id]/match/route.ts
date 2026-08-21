import { NextRequest, NextResponse } from 'next/server';

import { applyServiceMatching } from '@/features/matching/matching.service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Recomputes and persists a Prospect's service suggestions
 * (`suggestedServices`/`projectFit`/`estimatedBudget`) via the rules-based
 * matching engine. Manual trigger for a dashboard "Recompute suggestions"
 * button - the same computation also runs automatically after discovery
 * and enrichment. Returns 200 with the outcome in the body for
 * `invalid_signal`, matching this app's established per-item-outcome
 * convention (`win/route.ts`). Only a genuinely missing Prospect is a 404.
 */
export async function POST(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const result = await applyServiceMatching(id);

  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  return NextResponse.json(result);
}
