import { z } from 'zod';

import { serviceTypeSchema } from '@/features/pricing/service-catalog';
import {
  companySizeSchema,
  industrySchema,
  statusHistoryEntrySchema,
} from '@/features/prospects/prospect.types';

// Mirrors the enums/models defined in prisma/schema.prisma. Kept in sync by
// hand since Prisma's generated types describe persistence shape, not the
// validated shape of data crossing API boundaries — same convention as
// prospect.types.ts.

export { serviceTypeSchema };
export type { ServiceType } from '@/features/pricing/service-catalog';

export const jobCadenceSchema = z.enum(['one_off', 'recurring']);
export type JobCadence = z.infer<typeof jobCadenceSchema>;

export const jobStatusSchema = z.enum(['active', 'delivered', 'monthly', 'cancelled']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const retainerDiscountSchema = z.enum(['free', 'half_price']);
export type RetainerDiscount = z.infer<typeof retainerDiscountSchema>;

export const jobSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  service: serviceTypeSchema,
  cadence: jobCadenceSchema,
  status: jobStatusSchema,
  agreedPriceCents: z.number().int(),
  soldAt: z.coerce.date(),
  deliveredAt: z.coerce.date().nullable(),
  freeRevisionRoundsUsed: z.number().int(),
  freeRevisionWindowEndsAt: z.coerce.date().nullable(),
  retainerDiscount: retainerDiscountSchema.nullable(),
  retainerDiscountEndsAt: z.coerce.date().nullable(),
  lastRetentionTouchAt: z.coerce.date().nullable(),
  retentionTouchCount: z.number().int(),
  statusHistory: z.array(statusHistoryEntrySchema),
  notes: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Job = z.infer<typeof jobSchema>;

export const clientSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  prospectId: z.string().nullable(),
  companyName: z.string(),
  domain: z.string().nullable(),
  contactName: z.string().nullable(),
  contactTitle: z.string().nullable(),
  contactEmail: z.string().nullable(),
  industry: industrySchema,
  companySize: companySizeSchema,
  doNotContact: z.boolean(),
  notes: z.string().nullable(),
  statusHistory: z.array(statusHistoryEntrySchema),
  jobs: z.array(jobSchema),
});
export type Client = z.infer<typeof clientSchema>;
