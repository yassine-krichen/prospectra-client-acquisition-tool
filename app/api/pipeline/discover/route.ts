import { NextRequest, NextResponse } from 'next/server';

import { discoverRequestSchema } from '@/features/discovery/discovery.types';
import { runDiscovery } from '@/features/discovery/discovery.service';

/**
 * Dashboard-triggered counterpart to `api/cron/discover` — runs the same
 * discovery pipeline on demand from a human clicking "Run discovery" in the
 * UI. Session-gated by `proxy.ts` (this route isn't under `api/cron/`, so
 * it's not exempt), so it deliberately does not check `x-cron-secret` — a
 * logged-in dashboard session is the authorization here, same as
 * `api/queue/approve`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const fromBody = discoverRequestSchema.safeParse(body);
  const fromQuery = discoverRequestSchema.safeParse({
    category: request.nextUrl.searchParams.get('category'),
    geography: request.nextUrl.searchParams.get('geography'),
    branch: request.nextUrl.searchParams.get('branch') ?? undefined,
  });

  const parsed = fromBody.success ? fromBody : fromQuery;
  if (!parsed.success) {
    return NextResponse.json({ error: 'category and geography are required.' }, { status: 400 });
  }

  const { category, geography, branch } = parsed.data;
  const summary = await runDiscovery({ category, geography }, branch);
  return NextResponse.json(summary);
}
