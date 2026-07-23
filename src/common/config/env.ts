import { z } from 'zod';

// Fail fast on missing/malformed env vars instead of failing later when a
// feature that needs them is first exercised.
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DASHBOARD_PASSWORD: z.string().min(1, 'DASHBOARD_PASSWORD must not be empty'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  // Discovery source API keys aren't available yet. Left optional so the app
  // boots without them — the sources that need them report themselves as
  // unavailable at call time instead of crashing the whole discovery run.
  GOOGLE_PLACES_API_KEY: z.string().min(1).optional(),
  BUILTWITH_API_KEY: z.string().min(1).optional(),
  // Branch B (startup/SaaS discovery) source keys — same graceful-skip
  // pattern as the Branch A keys above.
  PRODUCT_HUNT_API_TOKEN: z.string().min(1).optional(),
  CRUNCHBASE_API_KEY: z.string().min(1).optional(),
  // Unlike the other source keys, GitHub's API works unauthenticated (at a
  // much lower rate limit), so its source treats a missing token as
  // "reduced rate limit", not "unavailable".
  GITHUB_TOKEN: z.string().min(1).optional(),
  // Branch C (contact enrichment) source keys — same graceful-skip pattern.
  HUNTER_API_KEY: z.string().min(1).optional(),
  PEOPLE_DATA_LABS_API_KEY: z.string().min(1).optional(),
  // Stage 2 drafting LLM keys — same graceful-skip pattern as the source
  // keys above: model-rotation.ts reports a provider unavailable and fails
  // over to the other when unset. Each accepts a comma-separated list of
  // keys for simple round-robin rotation (see model-rotation.ts).
  GEMINI_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  // Base URL of the local claude-web-bridge sibling app used for the
  // Stage 2 humanizer pass. Optional — claude-bridge.client.ts defaults to
  // http://127.0.0.1:3000 in code when unset, so this only needs setting
  // for a non-local bridge deployment.
  CLAUDE_BRIDGE_URL: z.string().url().optional(),
  // Bearer token for the claude-web-bridge's own optional API_KEY auth.
  // Optional — a local dev bridge instance may not have one configured.
  CLAUDE_BRIDGE_API_KEY: z.string().min(1).optional(),
  // Protects the discovery cron route. Required (unlike the source keys
  // above) since the route itself has no safe "disabled" state to fall back
  // to — fail closed at boot rather than at first request.
  CRON_SECRET: z.string().min(32, 'CRON_SECRET must be at least 32 characters'),
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
