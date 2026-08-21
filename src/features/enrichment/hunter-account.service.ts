import { env } from '@/common/config/env';

const HUNTER_ACCOUNT_URL = 'https://api.hunter.io/v2/account';

// Minimal subset of Hunter's actual /v2/account response this app reads.
interface HunterAccountResponse {
  data: {
    plan_name: string;
    reset_date: string;
    requests: {
      searches: { used: number; available: number; remaining: number };
    };
  };
}

export interface HunterAccountUsage {
  configured: boolean;
  planName: string | null;
  used: number | null;
  available: number | null;
  remaining: number | null;
  resetDate: string | null;
  error: string | null;
}

const NOT_CONFIGURED: HunterAccountUsage = {
  configured: false,
  planName: null,
  used: null,
  available: null,
  remaining: null,
  resetDate: null,
  error: null,
};

function errorResult(error: string): HunterAccountUsage {
  return { ...NOT_CONFIGURED, configured: true, error };
}

/**
 * Real Hunter.io account usage, straight from Hunter's own /v2/account
 * endpoint - not this app's local `ApiUsageCounter` tally, which only
 * counts calls made through this app and can drift from the account's real
 * state (e.g. a test run that writes to the counter without a real Hunter
 * call, or the counter table being wiped independently of Hunter's own
 * side). This is the display source of truth; `hunter.source.ts`'s
 * MONTHLY_FREE_TIER_CAP + local counter remain the actual call-blocking
 * gate (a single atomic Postgres UPDATE, deliberately not a live call - see
 * that file's doc comment) and are untouched by this. Never throws.
 */
export async function getHunterAccountUsage(): Promise<HunterAccountUsage> {
  if (!env.HUNTER_API_KEY) {
    return NOT_CONFIGURED;
  }

  const url = new URL(HUNTER_ACCOUNT_URL);
  url.searchParams.set('api_key', env.HUNTER_API_KEY);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return errorResult(`Hunter account request failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    return errorResult(`Hunter account API responded with ${response.status}`);
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = body as Partial<HunterAccountResponse> | null;
  if (!parsed?.data?.requests?.searches) {
    return errorResult('Hunter account API response did not match the expected shape');
  }

  const { data } = parsed;
  return {
    configured: true,
    planName: data.plan_name,
    used: data.requests.searches.used,
    available: data.requests.searches.available,
    remaining: data.requests.searches.remaining,
    resetDate: data.reset_date,
    error: null,
  };
}
