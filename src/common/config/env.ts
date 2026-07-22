import { z } from 'zod';

// Fail fast on missing/malformed env vars instead of failing later when a
// feature that needs them is first exercised.
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DASHBOARD_PASSWORD: z.string().min(1, 'DASHBOARD_PASSWORD must not be empty'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
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
