import { z } from 'zod';

// .env ships every optional key as KEY="" (see .env.example) to document its
// existence rather than omitting the line. Next.js loads that as the literal
// empty string, not undefined, so `.optional()` alone never sees the
// "unset" case it's meant to allow. Preprocess "" -> undefined first so an
// optional field's own validator (.min(1), .url(), ...) only ever runs
// against a real value.
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);
const optionalString = (schema: z.ZodString) => z.preprocess(emptyToUndefined, schema.optional());
// Same "" -> undefined preprocessing applies below to DAILY_SEND_CAP_TEST/
// HOURLY_RATE_CENTS (via inline `z.preprocess(emptyToUndefined, ...)`, not a
// shared helper - Zod 4's `.default()` overload resolution doesn't infer
// cleanly through a generic passthrough): without it, KEY="" coerces to 0
// (Number('') === 0) before `.default()` ever gets a chance to apply, since
// `.default()` only fires on undefined, not on a present-but-empty value -
// failing `.positive()` instead of quietly falling back to the default like
// an absent key does.

// Fail fast on missing/malformed env vars instead of failing later when a
// feature that needs them is first exercised.
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DASHBOARD_PASSWORD: z.string().min(1, 'DASHBOARD_PASSWORD must not be empty'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  // Discovery source API keys aren't available yet. Left optional so the app
  // boots without them - the sources that need them report themselves as
  // unavailable at call time instead of crashing the whole discovery run.
  GOOGLE_PLACES_API_KEY: optionalString(z.string().min(1)),
  BUILTWITH_API_KEY: optionalString(z.string().min(1)),
  // Branch B (startup/SaaS discovery) source keys - same graceful-skip
  // pattern as the Branch A keys above.
  PRODUCT_HUNT_API_TOKEN: optionalString(z.string().min(1)),
  CRUNCHBASE_API_KEY: optionalString(z.string().min(1)),
  // Unlike the other source keys, GitHub's API works unauthenticated (at a
  // much lower rate limit), so its source treats a missing token as
  // "reduced rate limit", not "unavailable".
  GITHUB_TOKEN: optionalString(z.string().min(1)),
  // Branch C (contact enrichment) source keys - same graceful-skip pattern.
  HUNTER_API_KEY: optionalString(z.string().min(1)),
  PEOPLE_DATA_LABS_API_KEY: optionalString(z.string().min(1)),
  // Stage 2 drafting LLM keys - same graceful-skip pattern as the source
  // keys above: model-rotation.ts reports a provider unavailable and fails
  // over to another configured one when unset. Each accepts a comma-
  // separated list of keys for random rotation across keys (see
  // model-rotation.ts's provider registry).
  GEMINI_API_KEY: optionalString(z.string().min(1)),
  GROQ_API_KEY: optionalString(z.string().min(1)),
  // DeepSeek, the third registered drafting provider - same optional/
  // comma-separated-list/graceful-skip pattern as GEMINI_API_KEY/
  // GROQ_API_KEY above.
  DEEPSEEK_API_KEY: optionalString(z.string().min(1)),
  // Base URL of the local claude-web-bridge sibling app used for the
  // Stage 2 humanizer pass. Optional - claude-bridge.client.ts defaults to
  // http://127.0.0.1:3000 in code when unset, so this only needs setting
  // for a non-local bridge deployment.
  CLAUDE_BRIDGE_URL: optionalString(z.string().url()),
  // Bearer token for the claude-web-bridge's own optional API_KEY auth.
  // Optional - a local dev bridge instance may not have one configured.
  CLAUDE_BRIDGE_API_KEY: optionalString(z.string().min(1)),
  // Protects the discovery cron route. Required (unlike the source keys
  // above) since the route itself has no safe "disabled" state to fall back
  // to - fail closed at boot rather than at first request.
  CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 characters'),
  // Stage 3 send queue - resend.client.ts. Optional: no Resend account is
  // provisioned yet. Missing means every send attempt degrades to a typed
  // failure instead of crashing (same graceful-skip pattern as every other
  // external client), and - separately - the domain-verification-gate below
  // means no real volume can go out yet regardless.
  RESEND_API_KEY: optionalString(z.string().min(1)),
  // Local part of the outbound `from` address is fixed in resend.client.ts;
  // this only supplies the domain. Optional: no sending domain is owned yet.
  SENDING_DOMAIN: optionalString(z.string().min(1)),
  // Whether SPF/DKIM/DMARC are actually verified on SENDING_DOMAIN. THE hard
  // gate for send volume - see domain-verification-gate.ts. Deliberately NOT
  // z.coerce.boolean() (which treats any non-empty string, including
  // "false", as true): only the exact string "true" opens the gate, so an
  // unset, empty, or malformed value all fail closed to `false` rather than
  // accidentally opening it.
  DOMAIN_DNS_VERIFIED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  // Daily send cap enforced ONLY while DOMAIN_DNS_VERIFIED is false - see
  // getEffectiveDailyCap() in domain-verification-gate.ts. Small default
  // keeps pre-verification volume trivial even if this var is never set.
  DAILY_SEND_CAP_TEST: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(3)),
  // ISO date string marking when domain warmup began, used by
  // daily-cap.ts's ramp schedule (only ever consulted once the domain is
  // verified). Optional - unset/malformed is treated as "warmup hasn't
  // started" there, the most conservative reading.
  DOMAIN_WARMUP_START_DATE: optionalString(z.string().min(1)),
  // Signing secret for Resend's inbound webhook (app/api/webhooks/resend),
  // in Resend/Svix's `whsec_<base64>` format. Optional: no webhook is
  // provisioned yet. Deliberately NOT treated as "skip verification when
  // unset" like the other optional keys above - see
  // verify-resend-signature.ts: an unset secret means the webhook route
  // refuses every event rather than trusting anything unverified, matching
  // this app's fail-closed posture.
  RESEND_WEBHOOK_SECRET: optionalString(z.string().min(1)),
  // Hourly rate for work beyond a Job's bundled free-revision scope, and for
  // estimating manual-quote services (pricing/hourly-rate.ts's
  // `getHourlyRateCents`) where the fixed catalog has no price range at all
  // (e.g. the 201+ company-size tier). Has a sane default so the app boots
  // without a business decision on file yet; override once a real rate is set.
  HOURLY_RATE_CENTS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(5000)),
  // Neon Management API (console.neon.tech/api/v2) - a separate credential
  // from DATABASE_URL, used only to show real storage/compute/transfer
  // usage in the System Health panel. Optional: without it, that panel
  // shows "NO DATA" for these rather than a guessed number. Both required
  // together for this feature to activate - NEON_PROJECT_ID isn't
  // discoverable from DATABASE_URL alone (find it at console.neon.tech,
  // Project Settings > General, or via GET /api/v2/projects).
  NEON_API_KEY: optionalString(z.string().min(1)),
  NEON_PROJECT_ID: optionalString(z.string().min(1)),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }

  return result.data;
}

export const env = loadEnv();
