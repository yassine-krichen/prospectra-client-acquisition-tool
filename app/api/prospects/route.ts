import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  industrySchema,
  projectFitSchema,
  prospectSourceSchema,
  prospectStatusSchema,
  signalStrengthSchema,
  signalTypeSchema,
} from '@/features/prospects/prospect.types';
import { listProspects } from '@/features/prospects/prospects.repository';

// `URLSearchParams` values are always strings, so booleans/numbers are
// accepted as their string form and coerced explicitly below rather than via
// `z.coerce.boolean()` (which would treat the string "false" as truthy).
const querySchema = z.object({
  source: prospectSourceSchema.optional(),
  signalType: signalTypeSchema.optional(),
  signalStrength: signalStrengthSchema.optional(),
  reason: z.string().min(1).optional(),
  industry: industrySchema.optional(),
  projectFit: projectFitSchema.optional(),
  status: prospectStatusSchema.optional(),
  priorityScoreMin: z.coerce.number().int().optional(),
  priorityScoreMax: z.coerce.number().int().optional(),
  hasVerifiedEmail: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  seen: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  hasDraftFailure: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  hasDomain: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  opened: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  sortField: z.enum(['priorityScore', 'discoveredAt', 'sentAt']).optional(),
  sortDirection: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = querySchema.safeParse(params);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query parameters.', issues: parsed.error.issues }, { status: 400 });
  }

  const {
    source,
    signalType,
    signalStrength,
    reason,
    industry,
    projectFit,
    status,
    priorityScoreMin,
    priorityScoreMax,
    hasVerifiedEmail,
    seen,
    hasDraftFailure,
    hasDomain,
    opened,
    sortField,
    sortDirection,
    cursor,
    limit,
  } = parsed.data;

  const result = await listProspects({
    filters: {
      source,
      signalType,
      signalStrength,
      reason,
      industry,
      projectFit,
      status,
      priorityScoreMin,
      priorityScoreMax,
      hasVerifiedEmail,
      seen,
      hasDraftFailure,
      hasDomain,
      opened,
    },
    sortField,
    sortDirection,
    cursor,
    limit,
  });

  return NextResponse.json(result);
}
