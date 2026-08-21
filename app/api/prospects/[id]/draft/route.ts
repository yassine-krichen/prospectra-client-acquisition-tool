import { NextRequest, NextResponse } from 'next/server';

import { draftProspect } from '@/features/drafting/drafting.service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Runs Stage 2 drafting (LLM routing across Gemini/Groq, exactly 3 variants,
 * plus an inline humanizer pass for HIGH-priority prospects) for a single
 * existing prospect. Returns 200 with the created drafts on success, 200
 * with a `flagged` body when drafting was refused (missing signal, or no
 * LLM provider available) rather than a 4xx/5xx - a flagged outcome is an
 * expected, typed result, not a request or server error - and 404 if the
 * prospect doesn't exist.
 */
export async function POST(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const result = await draftProspect(id);
  if (!result) {
    return NextResponse.json({ error: 'Prospect not found.' }, { status: 404 });
  }

  return NextResponse.json(result);
}
