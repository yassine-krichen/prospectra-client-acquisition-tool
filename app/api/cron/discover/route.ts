import { NextRequest, NextResponse } from 'next/server';

import { env } from '@/common/config/env';
import { sha256Hex, timingSafeEqual } from '@/common/auth/session';
import { discoverRequestSchema } from '@/features/discovery/discovery.types';
import { runDiscovery } from '@/features/discovery/discovery.service';

const CRON_SECRET_HEADER = 'x-cron-secret';

// Fail closed, same pattern as the dashboard login flow: hash both sides to
// a fixed-length digest before the constant-time compare, since the
// timingSafeEqual's early length check would otherwise leak the secret's
// length for variable-length inputs.
async function isAuthorized(request: NextRequest): Promise<boolean> {
  const provided = request.headers.get(CRON_SECRET_HEADER);
  if (!provided) return false;

  const [providedHash, expectedHash] = await Promise.all([sha256Hex(provided), sha256Hex(env.CRON_SECRET)]);

  return timingSafeEqual(providedHash, expectedHash);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAuthorized(request))) {
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
