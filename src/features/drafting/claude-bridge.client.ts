import { z } from 'zod';

import { env } from '@/common/config/env';
import { recordBridgeRateLimit } from '@/features/drafting/bridge-budget';
import { parseDraftOutput } from '@/features/drafting/parse-draft-output';
import { buildHumanizePrompt } from '@/features/drafting/prompt-templates';
import type { DraftGenerationResult } from '@/features/drafting/drafting.types';

// Local sibling app (claude-web-bridge) that drives a real, logged-in
// Claude web session headlessly. Its real usage limit is ~40 messages per
// 8-hour window, SHARED across every caller of the bridge process — not
// per-caller here. This client makes exactly one bridge call per
// `humanize()`/`generateDraft()` invocation and never retries internally;
// callers (drafting.service.ts, the draft-batch cron, model-rotation.ts's
// tier-2 fallback) own the decision of how many prospects get a bridge call
// at all against that shared budget.
const DEFAULT_CLAUDE_BRIDGE_URL = 'http://127.0.0.1:3000';

// The bridge/source key `bridge-budget.ts`'s cooldown record is keyed under.
// Both `humanize()` and `generateDraft()` share this bridge process (and its
// one ~40-msgs/8h Claude quota), so they share one cooldown record too.
const BRIDGE_SOURCE = 'claude-bridge';

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

// Draft-generation call (Phase C's tier-2 fallback lane) shares the exact
// same success/failure shape every other provider client
// (gemini.client.ts/groq.client.ts/deepseek.client.ts) returns, so
// model-rotation.ts's fallback orchestration can treat it identically.
export type BridgeGenerationResult = DraftGenerationResult;

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

// Fallback backoff recorded against the shared cooldown when the bridge
// returns a 429 but its own body doesn't include a `retryAfter` — same
// reasoning as SERVICE_UNAVAILABLE_BACKOFF_SECONDS: a conservative fixed
// value is safer than recording no cooldown at all.
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 60;

// Internal shared shape for one raw bridge call, before either public
// function (`humanize`/`generateDraft`) interprets the successful text
// differently (plain rewritten text vs. a SUBJECT:/BODY: pair to parse).
type BridgeCallOutcome = HumanizeSuccess | HumanizeFailure;

/**
 * Makes one `POST /chat` call against the bridge with `provider: 'claude'`
 * and maps every documented outcome (a logged-out saved session, the shared
 * rate limit, no browser slot available, an unreachable bridge, or an
 * unexpected response shape) to a typed result — shared by `humanize()` and
 * `generateDraft()` so this error-handling isn't duplicated between them.
 * On a 429, records the shared cooldown via `bridge-budget.ts` before
 * returning, so every future caller (either lane, any serverless
 * invocation) sees the bridge is rate-limited without rediscovering it
 * itself.
 */
async function callBridgeChat(prompt: string): Promise<BridgeCallOutcome> {
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
      body: JSON.stringify({ prompt, provider: 'claude', stream: false }),
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
    const retryAfterSeconds = parsed.success ? parsed.data.retryAfter : undefined;
    await recordBridgeRateLimit(BRIDGE_SOURCE, retryAfterSeconds ?? DEFAULT_RATE_LIMIT_BACKOFF_SECONDS);
    return {
      ok: false,
      kind: 'rate_limited',
      reason: parsed.success ? parsed.data.error : 'claude-bridge rate limit reached',
      retryAfterSeconds,
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
  return callBridgeChat(buildHumanizePrompt(text));
}

/**
 * Generates one subject+body draft via the local claude-web-bridge sibling
 * app — Phase C's tier-2 overflow lane for original drafting, used only
 * when the primary Gemini/Groq/DeepSeek pool (model-rotation.ts) is
 * exhausted for a high-priority prospect (see `generateDraftWithFallback`).
 * Unlike `humanize()`, `prompt` here is sent as-is: the caller
 * (`buildDraftPrompt`) already produces a complete SUBJECT:/BODY:-format
 * generation prompt, so this function doesn't build its own. Reuses the
 * same `parse-draft-output.ts` parser every other provider client uses, so
 * a malformed response degrades to a typed `ok:false` rather than a
 * malformed persisted draft.
 */
export async function generateDraft(prompt: string): Promise<BridgeGenerationResult> {
  const outcome = await callBridgeChat(prompt);
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }

  const draft = parseDraftOutput(outcome.text);
  if (!draft) {
    return { ok: false, reason: 'claude-bridge response did not follow the SUBJECT:/BODY: format' };
  }

  return { ok: true, subject: draft.subject, body: draft.body };
}
