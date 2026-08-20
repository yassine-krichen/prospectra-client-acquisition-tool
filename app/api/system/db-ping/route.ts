import { NextResponse } from 'next/server';

import { prisma } from '@/common/db/client';

// Round-trip time of the cheapest possible real query against the actual
// configured DATABASE_URL - not a TCP-level ping (Neon is HTTP/WebSocket-
// proxied Postgres over the `pg` driver here, so a raw ICMP ping wouldn't
// measure what this app actually experiences on every request anyway).
const GOOD_LATENCY_MS = 100;

export interface DbPingResult {
  ok: boolean;
  latencyMs: number | null;
  good: boolean;
  error?: string;
}

/**
 * Session-gated (via proxy.ts, same as every other dashboard API route).
 * User-triggered from the System Health panel's "Ping Database" button -
 * deliberately not polled automatically, so it never runs more than the
 * user actually asks for.
 */
export async function GET(): Promise<NextResponse<DbPingResult>> {
  const start = performance.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    const latencyMs = Math.round(performance.now() - start);
    return NextResponse.json({ ok: true, latencyMs, good: latencyMs < GOOD_LATENCY_MS });
  } catch (error) {
    return NextResponse.json({ ok: false, latencyMs: null, good: false, error: (error as Error).message });
  }
}
