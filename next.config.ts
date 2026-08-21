import path from "node:path"

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly - otherwise Turbopack may infer it
  // from a sibling project's lockfile one directory up.
  turbopack: {
    root: path.join(__dirname),
  },
}

export default nextConfig
