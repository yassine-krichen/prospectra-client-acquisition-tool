import { env } from '@/common/config/env';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

// Minimal subset of Neon's actual project response this app reads. Neon's
// Management API reports real usage (storage, compute time, data transfer)
// but does NOT return the account's compute-time/data-transfer LIMITS
// anywhere in this endpoint - only the storage limit
// (`branch_logical_size_limit_bytes`) is present. Per this app's "never
// guess a metric" rule, compute/transfer are reported as raw usage with no
// invented cap or percentage.
interface NeonProjectResponse {
  project: {
    synthetic_storage_size: number;
    branch_logical_size_limit_bytes: number;
    compute_time_seconds: number;
    data_transfer_bytes: number;
    consumption_period_start: string;
    consumption_period_end: string;
  };
}

export interface NeonUsage {
  configured: boolean;
  storageUsedMB: number | null;
  storageLimitMB: number | null;
  storagePercentUsed: number | null;
  computeSecondsUsed: number | null;
  dataTransferMB: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  error: string | null;
}

const NOT_CONFIGURED: NeonUsage = {
  configured: false,
  storageUsedMB: null,
  storageLimitMB: null,
  storagePercentUsed: null,
  computeSecondsUsed: null,
  dataTransferMB: null,
  periodStart: null,
  periodEnd: null,
  error: null,
};

function errorResult(error: string): NeonUsage {
  return { ...NOT_CONFIGURED, configured: true, error };
}

const BYTES_PER_MB = 1024 * 1024;

/**
 * Real usage for the current Neon project, straight from Neon's own
 * Management API - not derived, not estimated. Requires NEON_API_KEY +
 * NEON_PROJECT_ID (a separate credential/id from DATABASE_URL); without
 * both, returns `configured: false` so the panel can show "NO DATA" rather
 * than fabricating a number. Never throws.
 */
export async function getNeonUsage(): Promise<NeonUsage> {
  if (!env.NEON_API_KEY || !env.NEON_PROJECT_ID) {
    return NOT_CONFIGURED;
  }

  let response: Response;
  try {
    response = await fetch(`${NEON_API_BASE}/projects/${env.NEON_PROJECT_ID}`, {
      headers: { Authorization: `Bearer ${env.NEON_API_KEY}`, Accept: 'application/json' },
    });
  } catch (error) {
    return errorResult(`Neon API request failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    return errorResult(`Neon API responded with ${response.status}`);
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = body as Partial<NeonProjectResponse> | null;
  if (!parsed?.project) {
    return errorResult('Neon API response did not match the expected shape');
  }

  const { project } = parsed;
  const storageUsedMB = project.synthetic_storage_size / BYTES_PER_MB;
  const storageLimitMB = project.branch_logical_size_limit_bytes / BYTES_PER_MB;

  return {
    configured: true,
    storageUsedMB: Math.round(storageUsedMB * 100) / 100,
    storageLimitMB: Math.round(storageLimitMB * 100) / 100,
    storagePercentUsed: Math.round((storageUsedMB / storageLimitMB) * 1000) / 10,
    computeSecondsUsed: project.compute_time_seconds,
    dataTransferMB: Math.round((project.data_transfer_bytes / BYTES_PER_MB) * 100) / 100,
    periodStart: project.consumption_period_start,
    periodEnd: project.consumption_period_end,
    error: null,
  };
}
