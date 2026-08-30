import path from "node:path"

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly - otherwise Turbopack may infer it
  // from a sibling project's lockfile one directory up.
  turbopack: {
    root: path.join(__dirname),
  },
  // Both packages do their own runtime file-system lookups for a binary
  // (playwright-core's browser registry, @sparticuz/chromium's bundled
  // Chromium build) that Next's build-time bundler/tracer can't see
  // through via static analysis - left external, they're `require()`d
  // as-is at runtime instead of bundled, which is what makes
  // @sparticuz/chromium's binary actually reach the deployed function.
  serverExternalPackages: ["@sparticuz/chromium", "playwright-core"],
}

export default nextConfig
