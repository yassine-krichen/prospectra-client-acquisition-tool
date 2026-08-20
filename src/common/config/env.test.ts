import { afterEach, describe, expect, it, vi } from "vitest"

// `env.ts` validates `process.env` and throws as a *module-level* side effect
// (`export const env = loadEnv()`), so each case here mutates `process.env`
// and forces a fresh module evaluation via `vi.resetModules()` + a dynamic
// import, rather than mocking the module itself.

const VALID_ENV = {
  DATABASE_URL: "postgresql://user:pass@example.neon.tech/biz_scraper?sslmode=require",
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

  // .env.example ships every optional key as KEY="" rather than omitting the
  // line, so this is the actual shape .env files have in practice - not an
  // edge case. An optional string field must treat "" the same as unset.
  it("treats an empty-string optional key (as shipped by .env.example) the same as unset, not a validation failure", async () => {
    setEnv({})
    process.env.GEMINI_API_KEY = ""
    process.env.CLAUDE_BRIDGE_URL = ""

    const { env } = await loadEnvModule()

    expect(env.GEMINI_API_KEY).toBeUndefined()
    expect(env.CLAUDE_BRIDGE_URL).toBeUndefined()
  })
})

// DOMAIN_DNS_VERIFIED is THE hard gate on real send volume (see
// domain-verification-gate.ts) - deliberately not z.coerce.boolean(), which
// would treat any non-empty string (including "false") as true. Only the
// exact literal string "true" may open the gate; every other value, including
// plausible-looking typos, must fail closed to `false`.
describe("env DOMAIN_DNS_VERIFIED parsing", () => {
  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  it('parses the exact string "true" as true', async () => {
    setEnv({})
    process.env.DOMAIN_DNS_VERIFIED = "true"

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(true)
  })

  it("defaults to false when DOMAIN_DNS_VERIFIED is unset", async () => {
    setEnv({})
    delete process.env.DOMAIN_DNS_VERIFIED

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(false)
  })

  it("parses an empty string as false", async () => {
    setEnv({})
    process.env.DOMAIN_DNS_VERIFIED = ""

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(false)
  })

  it('parses the string "false" as false (not coerced to true just for being a non-empty string)', async () => {
    setEnv({})
    process.env.DOMAIN_DNS_VERIFIED = "false"

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(false)
  })

  it('parses "1" as false - only the literal string "true" opens the gate', async () => {
    setEnv({})
    process.env.DOMAIN_DNS_VERIFIED = "1"

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(false)
  })

  it('parses "TRUE" (wrong case) as false', async () => {
    setEnv({})
    process.env.DOMAIN_DNS_VERIFIED = "TRUE"

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(false)
  })

  it('parses "yes" as false', async () => {
    setEnv({})
    process.env.DOMAIN_DNS_VERIFIED = "yes"

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(false)
  })

  it('parses a typo\'d value ("ture") as false rather than throwing', async () => {
    setEnv({})
    process.env.DOMAIN_DNS_VERIFIED = "ture"

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(false)
  })

  it('parses " true" (leading whitespace) as false - no trimming is applied', async () => {
    setEnv({})
    process.env.DOMAIN_DNS_VERIFIED = " true"

    const { env } = await loadEnvModule()

    expect(env.DOMAIN_DNS_VERIFIED).toBe(false)
  })
})

// DAILY_SEND_CAP_TEST backs the hard-gated cap in
// domain-verification-gate.ts's getEffectiveDailyCap() whenever
// DOMAIN_DNS_VERIFIED is false (the default/expected state right now).
describe("env DAILY_SEND_CAP_TEST parsing", () => {
  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  it("defaults to 3 when unset", async () => {
    setEnv({})
    delete process.env.DAILY_SEND_CAP_TEST

    const { env } = await loadEnvModule()

    expect(env.DAILY_SEND_CAP_TEST).toBe(3)
  })

  it("coerces a numeric string to a number", async () => {
    setEnv({})
    process.env.DAILY_SEND_CAP_TEST = "5"

    const { env } = await loadEnvModule()

    expect(env.DAILY_SEND_CAP_TEST).toBe(5)
  })

  it("throws at load time when DAILY_SEND_CAP_TEST is zero (must be positive)", async () => {
    setEnv({})
    process.env.DAILY_SEND_CAP_TEST = "0"

    await expect(loadEnvModule()).rejects.toThrow(/Invalid environment variables/)
  })

  it("throws at load time when DAILY_SEND_CAP_TEST is negative", async () => {
    setEnv({})
    process.env.DAILY_SEND_CAP_TEST = "-1"

    await expect(loadEnvModule()).rejects.toThrow(/Invalid environment variables/)
  })

  it("throws at load time when DAILY_SEND_CAP_TEST is not a number", async () => {
    setEnv({})
    process.env.DAILY_SEND_CAP_TEST = "not-a-number"

    await expect(loadEnvModule()).rejects.toThrow(/Invalid environment variables/)
  })
})
