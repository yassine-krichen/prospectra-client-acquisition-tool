import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '@/lib/generated/prisma/client';

// Dedicated Prisma client for the 7 destructive integration test files - see
// require-destructive-test-guard.ts. Deliberately reads `TEST_DATABASE_URL`
// directly from `process.env`, NOT via `@/common/config/env` (which only
// ever knows about `DATABASE_URL`, the app's real database) - this file must
// never be able to silently resolve to the same database the app uses.
//
// Exported as `prisma` so it's a drop-in replacement for
// `@/common/db/client`'s export shape: swapping a test file's own import
// (and `vi.mock`-redirecting `@/common/db/client` itself, so the production
// service code under test resolves here too) is the only change needed.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. The 7 destructive integration tests need a dedicated Neon branch, ' +
      'separate from DATABASE_URL - see the TEST_DATABASE_URL comment in .env.example for how to create one.'
  );
}

// Next.js hot-reloads modules in dev, which would otherwise instantiate a new
// PrismaClient (and a new connection pool) on every reload/vitest --watch
// rerun. Caching the instance on `globalThis` keeps a single client across
// reloads - same pattern as `@/common/db/client`.
const globalForPrisma = globalThis as unknown as { testPrisma: PrismaClient | undefined };

// Prisma 7 requires a driver adapter (or Accelerate) rather than connecting
// via the datasource URL directly.
const adapter = new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL });

export const prisma = globalForPrisma.testPrisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.testPrisma = prisma;
}
