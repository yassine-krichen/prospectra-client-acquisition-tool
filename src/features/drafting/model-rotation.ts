import { env } from '@/common/config/env';
import { generateGeminiDraft } from '@/features/drafting/gemini.client';
import { generateGroqDraft } from '@/features/drafting/groq.client';
import type { DraftGenerationResult, DraftingProvider, ModelRotationResult } from '@/features/drafting/drafting.types';

const PROVIDERS: readonly DraftingProvider[] = ['gemini', 'groq'];

function parseKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

// Both `GEMINI_API_KEY` and `GROQ_API_KEY` accept a comma-separated list of
// keys for simple round-robin rotation (e.g. to spread calls across several
// free-tier keys). Parsed once at module load since env doesn't change at
// runtime; the rotation indices below are mutable module state — acceptable
// since this app runs as a single-process cron/API worker, not a
// horizontally-scaled service that would need to share rotation state.
const geminiKeys = parseKeys(env.GEMINI_API_KEY);
const groqKeys = parseKeys(env.GROQ_API_KEY);
let geminiKeyIndex = 0;
let groqKeyIndex = 0;
let providerStartIndex = 0;

function nextKey(provider: DraftingProvider): string | null {
  if (provider === 'gemini') {
    if (geminiKeys.length === 0) return null;
    const key = geminiKeys[geminiKeyIndex % geminiKeys.length];
    geminiKeyIndex += 1;
    return key;
  }

  if (groqKeys.length === 0) return null;
  const key = groqKeys[groqKeyIndex % groqKeys.length];
  groqKeyIndex += 1;
  return key;
}

// Rotates which provider is tried FIRST across calls (not just which key
// within a provider), so load is spread across both Gemini and Groq rather
// than always hammering Gemini first and only falling to Groq on failure.
function providerOrder(): DraftingProvider[] {
  const start = providerStartIndex % PROVIDERS.length;
  providerStartIndex += 1;
  return [...PROVIDERS.slice(start), ...PROVIDERS.slice(0, start)];
}

async function runProvider(
  provider: DraftingProvider,
  prompt: string
): Promise<{ provider: DraftingProvider; result: DraftGenerationResult } | null> {
  const key = nextKey(provider);
  if (!key) return null; // not configured for this provider — not attempted

  const result = provider === 'gemini' ? await generateGeminiDraft(prompt, key) : await generateGroqDraft(prompt, key);
  return { provider, result };
}

/**
 * Generates one subject+body draft, rotating across Gemini and Groq (and
 * across comma-separated keys within each provider). Fails over to the
 * other provider when the first is unavailable (no key configured) or its
 * call errors. Only reports overall failure once both providers have been
 * tried and neither produced a usable draft — `drafting.service.ts` treats
 * that as "no LLM available", flagging the prospect rather than throwing.
 */
export async function generateDraftWithRotation(prompt: string): Promise<ModelRotationResult> {
  const reasons: string[] = [];

  for (const provider of providerOrder()) {
    const attempt = await runProvider(provider, prompt);
    if (!attempt) {
      reasons.push(`${provider}: not configured (no API key)`);
      continue;
    }

    if (attempt.result.ok) {
      return { ok: true, subject: attempt.result.subject, body: attempt.result.body, modelUsed: provider };
    }

    reasons.push(`${provider}: ${attempt.result.reason}`);
  }

  return { ok: false, reason: `no LLM available: ${reasons.join('; ')}` };
}
