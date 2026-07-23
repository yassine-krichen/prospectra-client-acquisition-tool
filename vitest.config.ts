import { defineConfig } from "vitest/config"
import tsconfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // `prospects.repository.test.ts` and `daily-send-counter.test.ts` are
    // integration tests that hit the real Postgres `Prospect` table and
    // truncate it in `beforeEach`. Running test files in parallel workers
    // races those two files against each other. The suite is small enough
    // that running files sequentially isn't a real cost, so we disable
    // file parallelism suite-wide rather than building a partial-parallelism
    // setup for two files.
    fileParallelism: false,
  },
})
