import { NextRequest } from "next/server"
import { describe, expect, it } from "vitest"

import { createSessionToken, SESSION_COOKIE_NAME } from "@/common/auth/session"

import { proxy } from "./proxy"

// Note: the exported `config.matcher` (which excludes /login, /api/login,
// /_next and /favicon.ico from ever reaching `proxy()`) is compiled and
// applied by Next.js's own routing layer, not by code in this repo. Verifying
// that exclusion would mean reimplementing Next's matcher compiler, which is
// a framework internal - out of scope here. What's tested below is the part
// this repo owns: what `proxy()` itself does with a request.

function requestWithCookie(cookieHeader?: string): NextRequest {
  return new NextRequest("http://localhost/dashboard", {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  })
}

describe("proxy", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const response = await proxy(requestWithCookie())

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://localhost/login")
  })

  it("redirects to /login when the session cookie is malformed", async () => {
    const response = await proxy(
      requestWithCookie(`${SESSION_COOKIE_NAME}=garbage`)
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://localhost/login")
  })

  it("redirects to /login when the session cookie signature is tampered", async () => {
    const token = await createSessionToken()
    const tamperedToken = `${token}x`

    const response = await proxy(
      requestWithCookie(`${SESSION_COOKIE_NAME}=${tamperedToken}`)
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://localhost/login")
  })

  it("passes the request through when the session cookie is valid", async () => {
    const token = await createSessionToken()

    const response = await proxy(
      requestWithCookie(`${SESSION_COOKIE_NAME}=${token}`)
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })
})
