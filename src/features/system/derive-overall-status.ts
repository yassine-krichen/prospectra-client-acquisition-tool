import type { SystemHealth } from '@/features/system/system-health.service';

export type OverallStatus = 'ok' | 'warning' | 'critical' | 'unknown';

const DB_WARNING_PERCENT = 75;
const DB_CRITICAL_PERCENT = 95;
const QUOTA_WARNING_REMAINING = 3;

/**
 * Reduces the full health payload down to one traffic-light status for the
 * sidebar's status dot. `critical` wins over `warning` wins over `ok` — the
 * dot always reflects the worst thing currently true, never an average.
 */
export function deriveOverallStatus(health: SystemHealth | null): OverallStatus {
  if (!health) return 'unknown';

  if (!health.database.reachable) return 'critical';
  if (health.database.percentUsed !== null && health.database.percentUsed >= DB_CRITICAL_PERCENT) return 'critical';

  if (health.database.percentUsed !== null && health.database.percentUsed >= DB_WARNING_PERCENT) return 'warning';
  if (health.hunter.configured && health.hunter.remaining !== null && health.hunter.remaining <= QUOTA_WARNING_REMAINING) {
    return 'warning';
  }
  if (health.bridgeInCooldown) return 'warning';
  if (health.sending.sentToday >= health.sending.dailyCap) return 'warning';

  return 'ok';
}
