import { NextRequest } from "next/server"
import { describe, expect, it } from "vitest"

import { SESSION_COOKIE_NAME, verifySessionToken } from "@/common/auth/session"
import { env } from "@/common/config/env"

import { POST } from "./route"

function loginRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/login", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function rawLoginRequest(rawBody: string): NextRequest {
  return new NextRequest("http://localhost/api/login", {
    method: "POST",
    body: rawBody,
  })
}

describe("POST /api/login", () => {
  it("rejects an incorrect password with 401 and sets no session cookie", async () => {
    const response = await POST(loginRequest({ password: "definitely-wrong" }))

    expect(response.status).toBe(401)
    expect(response.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it("never echoes the submitted password back in the error response body", async () => {
    const response = await POST(loginRequest({ password: "definitely-wrong" }))
    const body = await response.json()

    expect(JSON.stringify(body)).not.toContain("definitely-wrong")
  })

  it("rejects a missing password with 400 and sets no session cookie", async () => {
    const response = await POST(loginRequest({}))

    expect(response.status).toBe(400)
    expect(response.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined()
  })

  it("rejects malformed JSON bodies with 400 instead of throwing", async () => {
    const response = await POST(rawLoginRequest("not-json"))

    expect(response.status).toBe(400)
  })

  it("accepts the correct password, sets a session cookie that verifies as valid", async () => {
    const response = await POST(
      loginRequest({ password: env.DASHBOARD_PASSWORD })
    )

    expect(response.status).toBe(200)
    const cookie = response.cookies.get(SESSION_COOKIE_NAME)
    expect(cookie).toBeDefined()
    await expect(verifySessionToken(cookie?.value)).resolves.toBe(true)
  })

  it("sets the session cookie as httpOnly so client-side scripts cannot read it", async () => {
    const response = await POST(
      loginRequest({ password: env.DASHBOARD_PASSWORD })
    )

    const cookie = response.cookies.get(SESSION_COOKIE_NAME)
    expect(cookie?.httpOnly).toBe(true)
  })

  it("never echoes the correct password back in the success response body", async () => {
    const response = await POST(
      loginRequest({ password: env.DASHBOARD_PASSWORD })
    )
    const body = await response.json()

    expect(JSON.stringify(body)).not.toContain(env.DASHBOARD_PASSWORD)
  })
})
