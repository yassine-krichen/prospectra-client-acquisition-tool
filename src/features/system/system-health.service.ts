import { prisma } from '@/common/db/client';
import { env } from '@/common/config/env';
import { isBridgeInCooldown } from '@/features/drafting/bridge-budget';
import { getEffectiveDailyCap, isDomainVerified } from '@/features/sending/domain-verification-gate';
import { getTodaysSendCount } from '@/features/sending/daily-send-counter';
import { prospectStatusSchema } from '@/features/prospects/prospect.types';

// Neon's free tier caps a project at 0.5 GiB of storage. There's no API call
// this app can make to ask Neon "what's my plan's limit" (that needs a Neon
// API key, which is a separate, unrelated credential from DATABASE_URL) - so
// this is a soft, hardcoded assumption, not a fact read from Neon itself.
// Correct as of the free tier at the time this was written; if the project
// is ever upgraded to a paid Neon plan, update this constant.
const NEON_FREE_TIER_LIMIT_MB = 512;

// Mirrors hunter.source.ts's own MONTHLY_FREE_TIER_CAP - duplicated rather
// than imported because that constant is private to a module whose only
// public surface is "run an enrichment attempt", not "report your cap".
// Keep in sync if hunter.source.ts's cap ever changes.
const HUNTER_MONTHLY_FREE_TIER_CAP = 25;

function currentYearMonth(referenceDate: Date = new Date()): string {
  const year = referenceDate.getUTCFullYear();
  const month = String(referenceDate.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export interface DatabaseHealth {
  reachable: boolean;
  sizeMB: number | null;
  limitMB: number;
  percentUsed: number | null;
}

export interface QuotaStatus {
  configured: boolean;
  used: number;
  cap: number | null;
  remaining: number | null;
}

export interface SendingHealth {
  domainVerified: boolean;
  sentToday: number;
  dailyCap: number;
}

export interface ConfiguredServices {
  googlePlaces: boolean;
  builtwith: boolean;
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
  hunter: QuotaStatus;
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

async function getDatabaseHealth(): Promise<DatabaseHealth> {
  try {
    const rows = await prisma.$queryRaw<Array<{ size_bytes: bigint }>>`
      SELECT pg_database_size(current_database()) AS size_bytes
    `;
    const sizeBytes = rows[0]?.size_bytes;
    if (sizeBytes === undefined) {
      return { reachable: true, sizeMB: null, limitMB: NEON_FREE_TIER_LIMIT_MB, percentUsed: null };
    }
    const sizeMB = Number(sizeBytes) / (1024 * 1024);
    return {
      reachable: true,
      sizeMB: Math.round(sizeMB * 100) / 100,
      limitMB: NEON_FREE_TIER_LIMIT_MB,
      percentUsed: Math.round((sizeMB / NEON_FREE_TIER_LIMIT_MB) * 1000) / 10,
    };
  } catch {
    // A failed query here means the database itself is unreachable - worth
    // surfacing as a top-level "reachable: false" rather than throwing and
    // taking the whole health check down with it.
    return { reachable: false, sizeMB: null, limitMB: NEON_FREE_TIER_LIMIT_MB, percentUsed: null };
  }
}

async function getHunterQuota(): Promise<QuotaStatus> {
  if (!env.HUNTER_API_KEY) {
    return { configured: false, used: 0, cap: null, remaining: null };
  }

  const counter = await prisma.apiUsageCounter.findUnique({
    where: { source_yearMonth: { source: 'hunter', yearMonth: currentYearMonth() } },
  });
  const used = counter?.count ?? 0;

  return {
    configured: true,
    used,
    cap: HUNTER_MONTHLY_FREE_TIER_CAP,
    remaining: Math.max(HUNTER_MONTHLY_FREE_TIER_CAP - used, 0),
  };
}

/**
 * Aggregates every "how much do I have left" signal this app can answer
 * without calling out to a third party just to ask (Neon's own storage
 * quota isn't queryable this way - see `NEON_FREE_TIER_LIMIT_MB`'s doc
 * comment): DB storage headroom, Hunter's monthly free-tier quota, today's
 * send-cap usage, claude-bridge's cooldown state, which optional external
 * services actually have a key configured, and a status-by-status funnel
 * count of every Prospect on file. Backs the dashboard's system-health
 * panel - never throws, since a health check that itself crashes the page
 * defeats its own purpose.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const [database, hunter, sentToday, bridgeInCooldown, statusCounts] = await Promise.all([
    getDatabaseHealth(),
    getHunterQuota(),
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
