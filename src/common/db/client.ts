import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '@/lib/generated/prisma/client';
import { env } from '@/common/config/env';

// Next.js hot-reloads modules in dev, which would otherwise instantiate a new
// PrismaClient (and a new connection pool) on every reload. Caching the
// instance on `globalThis` keeps a single client across reloads.
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

// Prisma 7 requires a driver adapter (or Accelerate) rather than connecting
// via the datasource URL directly.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
