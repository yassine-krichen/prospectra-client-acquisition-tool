import { CompanySize as PrismaCompanySize } from '@/lib/generated/prisma/client';
import type { CompanySize } from '@/features/prospects/prospect.types';

// Prisma's generated client always exposes the Prisma-schema enum member
// name (e.g. "size_1_10") as both the TS type and the runtime JS value for
// reads/writes through the client - never the `@map`'d DB storage value
// ("1-10"). The domain `CompanySize` type in `prospect.types.ts` uses the
// human-readable "1-10" form, so every read/write through Prisma needs an
// explicit translation between the two.
const DOMAIN_TO_PRISMA: Record<CompanySize, PrismaCompanySize> = {
  '1-10': PrismaCompanySize.size_1_10,
  '11-50': PrismaCompanySize.size_11_50,
  '51-200': PrismaCompanySize.size_51_200,
  '201+': PrismaCompanySize.size_201_plus,
  unknown: PrismaCompanySize.unknown,
};

const PRISMA_TO_DOMAIN: Record<PrismaCompanySize, CompanySize> = {
  size_1_10: '1-10',
  size_11_50: '11-50',
  size_51_200: '51-200',
  size_201_plus: '201+',
  unknown: 'unknown',
};

export function toPrismaCompanySize(domain: CompanySize): PrismaCompanySize {
  const prismaValue = DOMAIN_TO_PRISMA[domain];
  if (prismaValue === undefined) {
    throw new Error(`toPrismaCompanySize: no Prisma mapping for domain value "${domain}"`);
  }
  return prismaValue;
}

export function fromPrismaCompanySize(prismaValue: PrismaCompanySize): CompanySize {
  const domain = PRISMA_TO_DOMAIN[prismaValue];
  if (domain === undefined) {
    throw new Error(`fromPrismaCompanySize: no domain mapping for Prisma value "${prismaValue}"`);
  }
  return domain;
}
