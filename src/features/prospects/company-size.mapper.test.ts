import { describe, expect, it } from 'vitest';

import { CompanySize as PrismaCompanySize } from '@/lib/generated/prisma/client';
import { fromPrismaCompanySize, toPrismaCompanySize } from './company-size.mapper';
import type { CompanySize } from '@/features/prospects/prospect.types';

// Every domain value (the human-readable "1-10" form used across the app)
// paired with the Prisma enum member name it must map to ("size_1_10" — the
// `@map`'d DB storage value is "1-10", but Prisma's generated client always
// exposes the enum member name at the TS/runtime boundary, never the mapped
// value). See the header comment in company-size.mapper.ts.
const DOMAIN_TO_PRISMA_PAIRS: ReadonlyArray<[CompanySize, PrismaCompanySize]> = [
  ['1-10', PrismaCompanySize.size_1_10],
  ['11-50', PrismaCompanySize.size_11_50],
  ['51-200', PrismaCompanySize.size_51_200],
  ['201+', PrismaCompanySize.size_201_plus],
  ['unknown', PrismaCompanySize.unknown],
];

describe('toPrismaCompanySize', () => {
  it.each(DOMAIN_TO_PRISMA_PAIRS)('maps domain value %s to Prisma enum member %s', (domain, prismaValue) => {
    expect(toPrismaCompanySize(domain)).toBe(prismaValue);
  });
});

describe('fromPrismaCompanySize', () => {
  it.each(DOMAIN_TO_PRISMA_PAIRS)('maps Prisma enum member %s back to domain value %s', (domain, prismaValue) => {
    expect(fromPrismaCompanySize(prismaValue)).toBe(domain);
  });
});

describe('round-trip', () => {
  it.each(DOMAIN_TO_PRISMA_PAIRS)(
    'round-trips domain value %s through toPrismaCompanySize -> fromPrismaCompanySize unchanged',
    (domain) => {
      expect(fromPrismaCompanySize(toPrismaCompanySize(domain))).toBe(domain);
    }
  );

  it.each(DOMAIN_TO_PRISMA_PAIRS)(
    'round-trips Prisma enum member %s through fromPrismaCompanySize -> toPrismaCompanySize unchanged',
    (_domain, prismaValue) => {
      expect(toPrismaCompanySize(fromPrismaCompanySize(prismaValue))).toBe(prismaValue);
    }
  );

  it('covers every member of the generated Prisma CompanySize enum', () => {
    const allPrismaValues = Object.values(PrismaCompanySize);
    const coveredPrismaValues = DOMAIN_TO_PRISMA_PAIRS.map(([, prismaValue]) => prismaValue);

    expect(new Set(coveredPrismaValues)).toEqual(new Set(allPrismaValues));
  });
});

describe('invalid input handling', () => {
  it('fails closed instead of silently returning undefined for a domain value with no mapping', () => {
    const invalidDomainValue = 'not-a-real-size' as CompanySize;

    expect(() => toPrismaCompanySize(invalidDomainValue)).toThrow();
  });

  it('fails closed instead of silently returning undefined for a Prisma value with no mapping', () => {
    const invalidPrismaValue = 'not_a_real_enum_member' as PrismaCompanySize;

    expect(() => fromPrismaCompanySize(invalidPrismaValue)).toThrow();
  });
});
