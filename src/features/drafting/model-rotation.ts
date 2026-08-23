import { env } from '@/common/config/env';
import { isBridgeInCooldown } from '@/features/drafting/bridge-budget';
import { generateDraft as generateBridgeDraft } from '@/features/drafting/claude-bridge.client';
import { generateGeminiDraft } from '@/features/drafting/gemini.client';
import { generateGroqDraft } from '@/features/drafting/groq.client';
import type { DraftGenerationResult, ModelRotationResult } from '@/features/drafting/drafting.types';

// Bridge-budget cooldown record is keyed under this same source string
// claude-bridge.client.ts itself uses - both lanes (humanize, and this
// module's tier-2 draft-generation fallback) share one cooldown record.
const BRIDGE_SOURCE = 'claude-bridge';

// The full set of providers this registry knows how to call. `DraftingProvider`
// (drafting.types.ts) is wider still - it also includes `'claude-bridge'`,
// the tier-2 fallback lane this registry itself never selects (see
// `generateDraftWithFallback` below).
//
// DeepSeek was dropped from this registry (2026-08-23): it's the one
// provider in the pool with no enforced cost cap (pay-per-token, unlike
// Gemini/Groq's free tiers or the bridge's cooldown-gated budget), and
// wasn't earning its slot. `deepseek.client.ts` and the `deepseek` member of
// the `ModelUsed` Prisma enum are untouched - historical `Draft` rows
// generated via DeepSeek still exist and still need to map/display
// correctly. This registry just never selects it for a NEW draft again.
export type ProviderId = 'gemini' | 'groq';

// Both `GEMINI_API_KEY`/`GROQ_API_KEY` accept a comma-separated list of keys
// for rotation across several free-tier keys.
function parseKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

interface ProviderDefinition {
  /** Parses this provider's comma-separated env var. Empty array means "not configured". */
  envKeys: () => string[];
  /** Makes one generation call against this provider with an already-selected key. */
  call: (apiKey: string, prompt: string) => Promise<DraftGenerationResult>;
}

// One entry per registered provider. Adding a new free-tier provider later
// means writing one client file (matching gemini.client.ts/groq.client.ts's
// pattern) and adding one entry here - no changes to the selection/failover
// logic below.
const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  gemini: {
    envKeys: () => parseKeys(env.GEMINI_API_KEY),
    call: (apiKey, prompt) => generateGeminiDraft(prompt, apiKey),
  },
  groq: {
    envKeys: () => parseKeys(env.GROQ_API_KEY),
    call: (apiKey, prompt) => generateGroqDraft(prompt, apiKey),
  },
};

const ALL_PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

function configuredProviders(): ProviderId[] {
  return ALL_PROVIDER_IDS.filter((id) => PROVIDERS[id].envKeys().length > 0);
}

// Uniform pick from a non-empty array. Callers are responsible for only
// calling this with non-empty arrays (checked at each call site below).
function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Generates one subject+body draft, selecting across every configured
 * provider (any registered provider with at least one parsed API key) and,
 * within it, across its comma-separated keys. Selection is uniformly random
 * rather than round-robin: unlike in-memory rotation-index state, a random
 * pick needs no state to persist across calls, which matters because this
 * app runs on Vercel serverless - module-level state doesn't survive cold
 * starts, so an index-based rotation silently stops rotating fairly there.
 * On failure (or a provider having no key at all), that provider is dropped
 * from the candidate pool and another is picked at random from what
 * remains, repeating until one succeeds or every configured provider has
 * been tried and failed - at which point `drafting.service.ts` treats the
 * result as "no LLM available" and flags the prospect rather than throwing.
 */
export async function generateDraftWithRotation(prompt: string): Promise<ModelRotationResult> {
  const reasons: string[] = [];

  for (const id of ALL_PROVIDER_IDS) {
    if (PROVIDERS[id].envKeys().length === 0) {
      reasons.push(`${id}: not configured (no API key)`);
    }
  }

  let candidates = configuredProviders();

  while (candidates.length > 0) {
    const provider = pickRandom(candidates);
    const keys = PROVIDERS[provider].envKeys();
    const key = pickRandom(keys);

    const result = await PROVIDERS[provider].call(key, prompt);
    if (result.ok) {
      return { ok: true, subject: result.subject, body: result.body, modelUsed: provider };
    }

    reasons.push(`${provider}: ${result.reason}`);
    candidates = candidates.filter((candidate) => candidate !== provider);
  }

  return { ok: false, reason: `no LLM available: ${reasons.join('; ')}` };
}

/**
 * `generateDraftWithRotation` (the bulk Gemini/Groq pool), with a
 * single tier-2 overflow attempt via claude-web-bridge when that whole pool
 * is exhausted - gated on BOTH conditions together, per the drafting
 * redesign plan:
 *
 * - `options.isHighPriority` - a low-priority prospect never touches the
 *   scarce, shared ~40-msgs/8h bridge budget, even during a temporary
 *   all-providers outage. It's flagged exactly as it is today.
 * - the bridge not already being in a known cooldown
 *   (`bridge-budget.ts`'s `isBridgeInCooldown`) - skips the bridge attempt
 *   entirely rather than burning a call already known to fail, and rather
 *   than risking discovering the same 429 redundantly from many concurrent
 *   high-priority prospects.
 *
 * The bridge attempt is a bonus try, not a replacement failure reason: if it
 * also fails, the returned reason preserves both lanes' failure detail
 * rather than only the bridge's.
 */
export async function generateDraftWithFallback(
  prompt: string,
  options: { isHighPriority: boolean }
): Promise<ModelRotationResult> {
  const primary = await generateDraftWithRotation(prompt);
  if (primary.ok) return primary;

  if (!options.isHighPriority) return primary;

  if (await isBridgeInCooldown(BRIDGE_SOURCE)) {
    return primary;
  }

  const bridgeResult = await generateBridgeDraft(prompt);
  if (bridgeResult.ok) {
    return { ok: true, subject: bridgeResult.subject, body: bridgeResult.body, modelUsed: 'claude-bridge' };
  }

  return {
    ok: false,
    reason: `${primary.reason}; claude-bridge fallback also failed: ${bridgeResult.reason}`,
  };
}
