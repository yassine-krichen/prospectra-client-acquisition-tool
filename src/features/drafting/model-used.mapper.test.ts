import { describe, expect, it } from 'vitest';

import { ModelUsed as PrismaModelUsed } from '@/lib/generated/prisma/client';
import { fromPrismaModelUsed, toPrismaModelUsed } from './model-used.mapper';
import type { ModelUsed } from '@/features/prospects/prospect.types';

// Every domain value (the "claude-bridge" hyphenated DB-storage form used
// across the app) paired with the Prisma enum member name it must map to
// ("claude_bridge" — the `@map`'d DB storage value is "claude-bridge", but
// Prisma's generated client always exposes the enum member name at the
// TS/runtime boundary, never the mapped value). See the header comment in
// model-used.mapper.ts / company-size.mapper.ts.
const DOMAIN_TO_PRISMA_PAIRS: ReadonlyArray<[ModelUsed, PrismaModelUsed]> = [
  ['gemini', PrismaModelUsed.gemini],
  ['groq', PrismaModelUsed.groq],
  ['claude-bridge', PrismaModelUsed.claude_bridge],
];

describe('toPrismaModelUsed', () => {
  it.each(DOMAIN_TO_PRISMA_PAIRS)('maps domain value %s to Prisma enum member %s', (domain, prismaValue) => {
    expect(toPrismaModelUsed(domain)).toBe(prismaValue);
  });
});

describe('fromPrismaModelUsed', () => {
  it.each(DOMAIN_TO_PRISMA_PAIRS)('maps Prisma enum member %s back to domain value %s', (domain, prismaValue) => {
    expect(fromPrismaModelUsed(prismaValue)).toBe(domain);
  });
});

describe('round-trip', () => {
  it.each(DOMAIN_TO_PRISMA_PAIRS)(
    'round-trips domain value %s through toPrismaModelUsed -> fromPrismaModelUsed unchanged',
    (domain) => {
      expect(fromPrismaModelUsed(toPrismaModelUsed(domain))).toBe(domain);
    }
  );

  it.each(DOMAIN_TO_PRISMA_PAIRS)(
    'round-trips Prisma enum member %s through fromPrismaModelUsed -> toPrismaModelUsed unchanged',
    (_domain, prismaValue) => {
      expect(toPrismaModelUsed(fromPrismaModelUsed(prismaValue))).toBe(prismaValue);
    }
  );

  it('covers every member of the generated Prisma ModelUsed enum', () => {
    const allPrismaValues = Object.values(PrismaModelUsed);
    const coveredPrismaValues = DOMAIN_TO_PRISMA_PAIRS.map(([, prismaValue]) => prismaValue);

    expect(new Set(coveredPrismaValues)).toEqual(new Set(allPrismaValues));
  });
});

// NOTE: company-size.mapper.ts previously had a bug where an invalid/unmapped
// input silently returned `undefined` at runtime instead of failing closed
// (fixed by adding an explicit undefined-check that throws — see
// company-size.mapper.test.ts's "invalid input handling" block). These two
// tests assert model-used.mapper.ts holds the same fail-closed contract.
// As of this writing, `toPrismaModelUsed`/`fromPrismaModelUsed` have NO such
// guard (no undefined-check, unlike company-size.mapper.ts's fixed version),
// so both tests below are expected to FAIL against the current
// implementation — see the fail-closed gap called out in the accompanying
// report. Do not "fix" these tests to match the current silent-passthrough
// behavior; the gap is in the source, not the test.
describe('invalid input handling', () => {
  it('fails closed instead of silently returning undefined for a domain value with no mapping', () => {
    const invalidDomainValue = 'not-a-real-model' as ModelUsed;

    expect(() => toPrismaModelUsed(invalidDomainValue)).toThrow();
  });

  it('fails closed instead of silently returning undefined for a Prisma value with no mapping', () => {
    const invalidPrismaValue = 'not_a_real_enum_member' as PrismaModelUsed;

    expect(() => fromPrismaModelUsed(invalidPrismaValue)).toThrow();
  });
});
