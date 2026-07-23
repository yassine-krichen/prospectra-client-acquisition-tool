import { afterEach, describe, expect, it, vi } from "vitest"

// `env.ts` validates `process.env` and throws as a *module-level* side effect
// (`export const env = loadEnv()`), so each case here mutates `process.env`
// and forces a fresh module evaluation via `vi.resetModules()` + a dynamic
// import, rather than mocking the module itself.

const VALID_ENV = {
  DATABASE_URL:
    "postgresql://postgres:postgres@localhost:5433/biz_scraper_test?schema=public",
  DASHBOARD_PASSWORD: "a-real-password",
  SESSION_SECRET: "a-secret-that-is-at-least-32-characters-long",
  CRON_SECRET: "a-cron-secret-that-is-at-least-32-characters-long",
}

const originalEnv = { ...process.env }

function setEnv(
  overrides: Partial<Record<keyof typeof VALID_ENV, string | undefined>>
): void {
  const merged = { ...VALID_ENV, ...overrides }
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function loadEnvModule(): Promise<typeof import("./env")> {
  vi.resetModules()
  return import("./env")
}

describe("env", () => {
  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  it("loads successfully when all required vars are present and valid", async () => {
    setEnv({})

    const { env } = await loadEnvModule()

    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL)
    expect(env.DASHBOARD_PASSWORD).toBe(VALID_ENV.DASHBOARD_PASSWORD)
    expect(env.SESSION_SECRET).toBe(VALID_ENV.SESSION_SECRET)
    expect(env.CRON_SECRET).toBe(VALID_ENV.CRON_SECRET)
  })

  it("throws at load time when DATABASE_URL is missing", async () => {
    setEnv({ DATABASE_URL: undefined })

    await expect(loadEnvModule()).rejects.toThrow(
      /Invalid environment variables/
    )
  })

  it("throws at load time when DATABASE_URL is not a valid URL", async () => {
    setEnv({ DATABASE_URL: "not-a-url" })

    await expect(loadEnvModule()).rejects.toThrow(
      /Invalid environment variables/
    )
  })

  it("throws at load time when DASHBOARD_PASSWORD is empty", async () => {
    setEnv({ DASHBOARD_PASSWORD: "" })

    await expect(loadEnvModule()).rejects.toThrow(
      /Invalid environment variables/
    )
  })

  it("throws at load time when SESSION_SECRET is missing", async () => {
    setEnv({ SESSION_SECRET: undefined })

    await expect(loadEnvModule()).rejects.toThrow(
      /Invalid environment variables/
    )
  })

  it("throws at load time when SESSION_SECRET is shorter than 32 characters", async () => {
    setEnv({ SESSION_SECRET: "too-short" })

    await expect(loadEnvModule()).rejects.toThrow(
      /Invalid environment variables/
    )
  })
})
