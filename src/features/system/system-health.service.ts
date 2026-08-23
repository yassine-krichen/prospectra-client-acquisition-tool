import { prisma } from '@/common/db/client';
import { env } from '@/common/config/env';
import { isBridgeInCooldown } from '@/features/drafting/bridge-budget';
import { getHunterAccountUsage, type HunterAccountUsage } from '@/features/enrichment/hunter-account.service';
import { getEffectiveDailyCap, isDomainVerified } from '@/features/sending/domain-verification-gate';
import { getTodaysSendCount } from '@/features/sending/daily-send-counter';
import { getNeonUsage, type NeonUsage } from '@/features/system/neon-usage.service';
import { prospectStatusSchema } from '@/features/prospects/prospect.types';

export interface DatabaseHealth {
  reachable: boolean;
  sizeMB: number | null;
}

export interface SendingHealth {
  domainVerified: boolean;
  sentToday: number;
  dailyCap: number;
}

export interface ConfiguredServices {
  googlePlaces: boolean;
  builtwith: boolean;
  companiesHouse: boolean;
  texasComptroller: boolean;
  productHunt: boolean;
  crunchbase: boolean;
  github: boolean;
  hunter: boolean;
  peopleDataLabs: boolean;
  gemini: boolean;
  groq: boolean;
  deepseek: boolean;
  claudeBridge: boolean;
  resend: boolean;
}

export interface SystemHealth {
  database: DatabaseHealth;
  neon: NeonUsage;
  hunter: HunterAccountUsage;
  sending: SendingHealth;
  bridgeInCooldown: boolean;
  configuredServices: ConfiguredServices;
  configuredPercent: number;
  prospectFunnel: Record<string, number>;
}

// "Configured" here means "has a usable key present" - the same signal
// every source/client in this app already uses to decide whether to
// attempt a call at all (see e.g. hunter.source.ts, builtwith.source.ts).
// Deliberately NOT a live reachability check against each provider: half
// of these (Hunter, the LLM providers) have hard free-tier request caps,
// so pinging all 12 just to render a percentage would spend real, scarce
// quota for no functional benefit. A configured-but-actually-broken
// service (e.g. GOOGLE_PLACES_API_KEY set but billing disabled - a real
// case this project hit) still counts as "configured" here; that failure
// mode shows up in the discovery run's own per-source result, not this
// number.
function computeConfiguredPercent(configuredServices: ConfiguredServices): number {
  const values = Object.values(configuredServices);
  const configuredCount = values.filter(Boolean).length;
  return Math.round((configuredCount / values.length) * 100);
}

// Real query against the actual configured database - not Neon's storage
// limit (this app has no way to know that without the Neon API; see
// neon-usage.service.ts, which reports the real limit when NEON_API_KEY/
// NEON_PROJECT_ID are configured, or "not configured" rather than a
// guessed cap when they aren't).
async function getDatabaseHealth(): Promise<DatabaseHealth> {
  try {
    const rows = await prisma.$queryRaw<Array<{ size_bytes: bigint }>>`
      SELECT pg_database_size(current_database()) AS size_bytes
    `;
    const sizeBytes = rows[0]?.size_bytes;
    if (sizeBytes === undefined) {
      return { reachable: true, sizeMB: null };
    }
    const sizeMB = Number(sizeBytes) / (1024 * 1024);
    return { reachable: true, sizeMB: Math.round(sizeMB * 100) / 100 };
  } catch {
    // A failed query here means the database itself is unreachable - worth
    // surfacing as a top-level "reachable: false" rather than throwing and
    // taking the whole health check down with it.
    return { reachable: false, sizeMB: null };
  }
}

/**
 * Aggregates every "how much do I have left" signal this app can answer:
 * DB storage (our own query) and real Neon usage (storage/compute/transfer,
 * straight from Neon's Management API when configured), Hunter's real
 * account usage (straight from Hunter's own /v2/account, not this app's
 * local call counter - see hunter-account.service.ts for why those two can
 * disagree), today's send-cap usage, claude-bridge's cooldown state, which
 * optional external services actually have a key configured, and a
 * status-by-status funnel count of every Prospect on file. Backs the
 * dashboard's system-health panel - never throws, since a health check that
 * itself crashes the page defeats its own purpose.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const [database, neon, hunter, sentToday, bridgeInCooldown, statusCounts] = await Promise.all([
    getDatabaseHealth(),
    getNeonUsage(),
    getHunterAccountUsage(),
    getTodaysSendCount(),
    isBridgeInCooldown('claude-bridge'),
    prisma.prospect.groupBy({ by: ['status'], _count: { status: true } }),
  ]);

  const prospectFunnel: Record<string, number> = Object.fromEntries(
    prospectStatusSchema.options.map((status) => [status, 0])
  );
  for (const row of statusCounts) {
    prospectFunnel[row.status] = row._count.status;
  }

  const configuredServices: ConfiguredServices = {
    googlePlaces: env.GOOGLE_PLACES_API_KEY !== undefined,
    builtwith: env.BUILTWITH_API_KEY !== undefined,
    companiesHouse: env.COMPANIES_HOUSE_API_KEY !== undefined,
    texasComptroller: env.TEXAS_COMPTROLLER_API_KEY !== undefined,
    productHunt: env.PRODUCT_HUNT_API_TOKEN !== undefined,
    crunchbase: env.CRUNCHBASE_API_KEY !== undefined,
    github: env.GITHUB_TOKEN !== undefined,
    hunter: env.HUNTER_API_KEY !== undefined,
    peopleDataLabs: env.PEOPLE_DATA_LABS_API_KEY !== undefined,
    gemini: env.GEMINI_API_KEY !== undefined,
    groq: env.GROQ_API_KEY !== undefined,
    deepseek: env.DEEPSEEK_API_KEY !== undefined,
    claudeBridge: env.CLAUDE_BRIDGE_URL !== undefined,
    resend: env.RESEND_API_KEY !== undefined,
  };

  return {
    database,
    neon,
    hunter,
    sending: {
      domainVerified: isDomainVerified(),
      sentToday,
      dailyCap: getEffectiveDailyCap(),
    },
    bridgeInCooldown,
    configuredServices,
    configuredPercent: computeConfiguredPercent(configuredServices),
    prospectFunnel,
  };
}
