import { NextResponse } from 'next/server';

import { listRecentDiscoveryRuns } from '@/features/discovery/discovery.service';

/**
 * Recent discovery-run history (search inputs + outcome counts) for the
 * Discovery page's "History" section, so the operator can see when a
 * category+geography+branch search was last run before re-running it.
 * Session-gated only via `proxy.ts` (not under `api/cron/`, so it's not
 * exempt) - same authorization pattern as `api/pipeline/discover`.
 */
export async function GET(): Promise<NextResponse> {
  const runs = await listRecentDiscoveryRuns();
  return NextResponse.json(runs);
}
