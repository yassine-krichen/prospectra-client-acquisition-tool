import { z } from 'zod';

import { env } from '@/common/config/env';
import { BANNED_PHRASES, fenceUntrustedData, MAX_WORDS, MIN_WORDS } from '@/features/drafting/prompt-templates';

// Local sibling app (claude-web-bridge) that drives a real, logged-in
// Claude web session headlessly. Its real usage limit is ~40 messages per
// 8-hour window, SHARED across every caller of the bridge process — not
// per-caller here. This client makes exactly one bridge call per
// `humanize()` invocation and never retries internally; callers
// (drafting.service.ts, the draft-batch cron) own the decision of how many
// prospects get a humanizer pass at all against that shared budget.
const DEFAULT_CLAUDE_BRIDGE_URL = 'http://127.0.0.1:3000';

export interface HumanizeSuccess {
  ok: true;
  text: string;
}

export type HumanizeFailureKind = 'rate_limited' | 'logged_out' | 'unavailable' | 'failure';

export interface HumanizeFailure {
  ok: false;
  kind: HumanizeFailureKind;
  reason: string;
  /**
   * Seconds to wait before retrying. Populated for `rate_limited` — either
   * the bridge's own reported `retryAfter` (429, the shared Claude quota) or
   * this client's fixed fallback backoff (503, no browser slot / an
   * unresolved Cloudflare-Arkose challenge — the bridge reports no
   * `retryAfter` for that case).
   */
  retryAfterSeconds?: number;
}

export type HumanizeResult = HumanizeSuccess | HumanizeFailure;

const chatResponseSchema = z.object({
  response: z.string(),
  sessionId: z.string(),
});

const errorResponseSchema = z.object({
  error: z.string(),
  retryAfter: z.number().optional(),
});

// The bridge reports no retryAfter for 503 — this fixed backoff is this
// client's own choice, not part of the bridge's documented contract.
const SERVICE_UNAVAILABLE_BACKOFF_SECONDS = 60;

// `draftText` was itself generated from prospect data that ultimately
// originates from scraped third-party sources (a Google Places listing, a
// GitHub README, etc.) — untrusted external data, not instructions. It's
// fenced off via `fenceUntrustedData` (shared with
// prompt-templates.ts's `buildDraftPrompt`) as defense-in-depth against
// prompt injection.
function buildHumanizePrompt(draftText: string): string {
  const bannedPhraseList = BANNED_PHRASES.map((phrase) => `"${phrase}"`).join(', ');

  return `Rewrite the following cold outreach email so it reads as more natural and
human-written, while strictly preserving:
- its meaning and every factual claim in it,
- its length (stay within ${MIN_WORDS}-${MAX_WORDS} words),
- exactly one specific observation and exactly one soft ask (do not add,
  remove, or turn the ask into a hard call-to-action),
- avoiding all of these clichés or close paraphrases of them: ${bannedPhraseList}.

Respond with ONLY the rewritten email body — no preamble, no explanation, no
surrounding quotes.

${fenceUntrustedData('ORIGINAL DRAFT', draftText)}`;
}

/**
 * Runs a one-shot humanizer pass on a draft's body via the local
 * claude-web-bridge sibling app (`POST /chat`, `provider: "claude"`,
 * non-streaming, no `sessionId` — each call is independent, and the
 * response's `sessionId` is deliberately discarded rather than reused
 * across drafts). Never throws: every documented bridge outcome — including
 * the shared rate limit (429), a logged-out saved browser session (424,
 * which needs manual re-login and is reported distinctly so it isn't
 * mistaken for a transient failure), and an unreachable bridge — maps to a
 * typed `HumanizeResult`, so a busy or misconfigured bridge degrades a
 * single draft's humanizing rather than the whole drafting run.
 */
export async function humanize(text: string): Promise<HumanizeResult> {
  const baseUrl = env.CLAUDE_BRIDGE_URL ?? DEFAULT_CLAUDE_BRIDGE_URL;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.CLAUDE_BRIDGE_API_KEY) {
    headers.Authorization = `Bearer ${env.CLAUDE_BRIDGE_API_KEY}`;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: buildHumanizePrompt(text), provider: 'claude', stream: false }),
    });
  } catch (error) {
    return { ok: false, kind: 'unavailable', reason: `claude-bridge unreachable (${(error as Error).message})` };
  }

  if (response.status === 424) {
    return {
      ok: false,
      kind: 'logged_out',
      reason:
        "claude-bridge's saved browser login session is logged out — re-run the bridge's setup script to log back in",
    };
  }

  if (response.status === 429) {
    const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
    return {
      ok: false,
      kind: 'rate_limited',
      reason: parsed.success ? parsed.data.error : 'claude-bridge rate limit reached',
      retryAfterSeconds: parsed.success ? parsed.data.retryAfter : undefined,
    };
  }

  if (response.status === 503) {
    const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
    return {
      ok: false,
      kind: 'rate_limited',
      reason: parsed.success ? parsed.data.error : 'claude-bridge has no browser slot available (transient)',
      retryAfterSeconds: SERVICE_UNAVAILABLE_BACKOFF_SECONDS,
    };
  }

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(await response.json().catch(() => null));
    return {
      ok: false,
      kind: 'failure',
      reason: parsed.success ? parsed.data.error : `claude-bridge responded with ${response.status}`,
    };
  }

  const parsed = chatResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, kind: 'failure', reason: 'claude-bridge response did not match the expected shape' };
  }

  return { ok: true, text: parsed.data.response };
}
