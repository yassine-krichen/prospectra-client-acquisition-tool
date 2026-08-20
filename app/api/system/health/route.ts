import { NextResponse } from 'next/server';

import { getSystemHealth } from '@/features/system/system-health.service';

/**
 * Session-gated (via proxy.ts, same as every other dashboard API route) -
 * no cron-secret variant exists for this one since nothing schedules it,
 * only the dashboard's system-health panel polls it.
 */
export async function GET(): Promise<NextResponse> {
  const health = await getSystemHealth();
  return NextResponse.json(health);
}
