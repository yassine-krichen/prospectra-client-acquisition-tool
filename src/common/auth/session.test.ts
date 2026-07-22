import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createSessionToken,
  SESSION_MAX_AGE_SECONDS,
  verifySessionToken,
} from "./session"

describe("createSessionToken / verifySessionToken", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("round-trips a freshly created token through verification", async () => {
    const token = await createSessionToken()

    await expect(verifySessionToken(token)).resolves.toBe(true)
  })

  it("rejects an undefined token", async () => {
    await expect(verifySessionToken(undefined)).resolves.toBe(false)
  })

  it("rejects an empty string token", async () => {
    await expect(verifySessionToken("")).resolves.toBe(false)
  })

  it("rejects a token missing the signature segment", async () => {
    await expect(verifySessionToken("1690000000000")).resolves.toBe(false)
  })

  it("rejects a token missing the issued-at segment", async () => {
    await expect(verifySessionToken(".some-signature")).resolves.toBe(false)
  })

  it("rejects a token with a tampered signature, without throwing", async () => {
    const token = await createSessionToken()
    const [issuedAt, signature] = token.split(".")
    const tamperedSignature =
      signature.slice(0, -1) + (signature.at(-1) === "a" ? "b" : "a")
    const tamperedToken = `${issuedAt}.${tamperedSignature}`

    await expect(verifySessionToken(tamperedToken)).resolves.toBe(false)
  })

  it("rejects a token with a tampered issued-at timestamp", async () => {
    const token = await createSessionToken()
    const [issuedAt, signature] = token.split(".")
    const tamperedIssuedAt = String(Number(issuedAt) + 1)
    const tamperedToken = `${tamperedIssuedAt}.${signature}`

    await expect(verifySessionToken(tamperedToken)).resolves.toBe(false)
  })

  it("rejects arbitrary garbage input without throwing", async () => {
    await expect(verifySessionToken("not.a.valid.token.at.all")).resolves.toBe(
      false
    )
    await expect(verifySessionToken("....")).resolves.toBe(false)
  })

  it("rejects a token whose age exceeds the max session lifetime", async () => {
    const token = await createSessionToken()

    const eightDaysMs = (SESSION_MAX_AGE_SECONDS + 24 * 60 * 60) * 1000
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + eightDaysMs)

    await expect(verifySessionToken(token)).resolves.toBe(false)
  })

  it("accepts a token right up to the max session lifetime boundary", async () => {
    const token = await createSessionToken()

    vi.useFakeTimers()
    // Just under the boundary — should still be valid.
    vi.setSystemTime(Date.now() + SESSION_MAX_AGE_SECONDS * 1000 - 1000)

    await expect(verifySessionToken(token)).resolves.toBe(true)
  })

  it("rejects a token whose issued-at timestamp is in the future", async () => {
    vi.useFakeTimers()
    const future = Date.now() + 60 * 60 * 1000
    vi.setSystemTime(future)
    const futureToken = await createSessionToken()

    vi.useRealTimers()

    await expect(verifySessionToken(futureToken)).resolves.toBe(false)
  })
})
