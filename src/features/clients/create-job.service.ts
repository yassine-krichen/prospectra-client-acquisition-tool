import { prisma } from '@/common/db/client';
import { getServiceCadence, RETAINER_LOCKIN_MONTHS } from '@/features/pricing/service-catalog';
import type { CreateJobRequest } from '@/features/clients/client.types';

// The one production write path for recording a sold service against a
// Client - without this, the entire pricing-catalog/matching-engine surface
// (Phase 6/7) has no reachable entry point outside test fixtures and manual
// DB inserts. `cadence` is always derived from `service` (see
// `getServiceCadence`), never caller-supplied, so a Job can never be created
// with a mismatched service+cadence pairing (e.g. a "recurring" landing_page).

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30 * MS_PER_DAY; // Calendar-month precision isn't needed here - RETAINER_LOCKIN_MONTHS is a marketing lock-in window, not a billing-cycle boundary.

export type CreateJobOutcome =
  | { outcome: 'created'; jobId: string }
  | { outcome: 'client_not_found' }
  | { outcome: 'invalid_input'; reason: string };

/**
 * Creates a Job for an existing Client. `retainerDiscount` is only valid
 * alongside `infra_hosting_retainer` (the catalog's lock-in discount is
 * specific to that service) - supplying it for any other service is
 * `invalid_input`, not silently ignored. When supplied, `retainerDiscountEndsAt`
 * is stamped `RETAINER_LOCKIN_MONTHS` out from creation.
 */
export async function createJob(clientId: string, request: CreateJobRequest): Promise<CreateJobOutcome> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) return { outcome: 'client_not_found' };

  if (request.retainerDiscount && request.service !== 'infra_hosting_retainer') {
    return {
      outcome: 'invalid_input',
      reason: 'retainerDiscount is only valid for the infra_hosting_retainer service.',
    };
  }

  const cadence = getServiceCadence(request.service);
  const now = new Date();
  const retainerDiscountEndsAt = request.retainerDiscount
    ? new Date(now.getTime() + RETAINER_LOCKIN_MONTHS * MS_PER_MONTH)
    : null;

  const job = await prisma.job.create({
    data: {
      clientId,
      service: request.service,
      cadence,
      status: 'active',
      agreedPriceCents: request.agreedPriceCents,
      soldAt: now,
      retainerDiscount: request.retainerDiscount ?? null,
      retainerDiscountEndsAt,
      notes: request.notes ?? null,
      statusHistory: [{ status: 'active', timestamp: now.toISOString() }],
    },
    select: { id: true },
  });

  return { outcome: 'created', jobId: job.id };
}
