import { ModelUsed as PrismaModelUsed } from '@/lib/generated/prisma/client';
import type { ModelUsed } from '@/features/prospects/prospect.types';

// Same translation need as company-size.mapper.ts: Prisma's generated
// client exposes the schema enum's member name ("claude_bridge") as both
// the TS type and the runtime value for reads/writes — never the `@map`'d
// DB storage value ("claude-bridge") the domain `ModelUsed` type uses.
const DOMAIN_TO_PRISMA: Record<ModelUsed, PrismaModelUsed> = {
  gemini: PrismaModelUsed.gemini,
  groq: PrismaModelUsed.groq,
  deepseek: PrismaModelUsed.deepseek,
  'claude-bridge': PrismaModelUsed.claude_bridge,
};

const PRISMA_TO_DOMAIN: Record<PrismaModelUsed, ModelUsed> = {
  gemini: 'gemini',
  groq: 'groq',
  deepseek: 'deepseek',
  claude_bridge: 'claude-bridge',
};

export function toPrismaModelUsed(domain: ModelUsed): PrismaModelUsed {
  const prismaValue = DOMAIN_TO_PRISMA[domain];
  if (prismaValue === undefined) {
    throw new Error(`toPrismaModelUsed: no Prisma mapping for domain value "${domain}"`);
  }
  return prismaValue;
}

export function fromPrismaModelUsed(prismaValue: PrismaModelUsed): ModelUsed {
  const domain = PRISMA_TO_DOMAIN[prismaValue];
  if (domain === undefined) {
    throw new Error(`fromPrismaModelUsed: no domain mapping for Prisma value "${prismaValue}"`);
  }
  return domain;
}
