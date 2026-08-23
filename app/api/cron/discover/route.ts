import { NextRequest, NextResponse } from 'next/server';

import { isAuthorizedByCronBearer, isAuthorizedByCronHeader } from '@/common/auth/cron-auth';
import { discoverRequestSchema } from '@/features/discovery/discovery.types';
import { runDiscovery } from '@/features/discovery/discovery.service';
import { NY_TARGET_GEOGRAPHY, pickDailyCategory } from '@/features/discovery/ny-target-categories';

// Scraper-based sources (Yellow Pages, Indie Hackers) can be slow,
// especially with retry-with-backoff on transient failures - give both
// handlers below more room than Vercel's default function timeout.
export const maxDuration = 60;

// Manual/ad-hoc discovery: caller picks category+geography+branch explicitly
// (dashboard ops, one-off backfills). Auth via `x-cron-secret` header.
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronHeader(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

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

// Vercel Cron entry point (see vercel.json): one call a day, no way to pass
// a body, so category/geography aren't caller-supplied here. Instead cycles
// through a fixed New York target-category list (`ny-target-categories.ts`)
// deterministically by date, and runs every discovery source (`'both'`)
// since Branch B sources ignore geography and treat category as a loose
// keyword anyway.
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorizedByCronBearer(request))) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const category = pickDailyCategory(new Date());
  const summary = await runDiscovery({ category, geography: NY_TARGET_GEOGRAPHY }, 'both');
  return NextResponse.json(summary);
}
