import { z } from 'zod';

// Mirrors the `ServiceType` enum in prisma/schema.prisma. Split out from
// service-catalog.ts (which owns everything else about the catalog) because
// this schema is also needed by prospect.types.ts, which client components
// (e.g. prospects-table.tsx) import - service-catalog.ts pulls in
// `@/common/config/env` for getHourlyRateCents(), and env.ts validates
// server secrets (DATABASE_URL, etc.) that don't exist in the browser.
// Bundling that env import into client code crashes the page on load.
export const serviceTypeSchema = z.enum([
  'landing_page',
  'full_stack_app',
  'linkedin_media_management',
  'infra_hosting_retainer',
]);
export type ServiceType = z.infer<typeof serviceTypeSchema>;
