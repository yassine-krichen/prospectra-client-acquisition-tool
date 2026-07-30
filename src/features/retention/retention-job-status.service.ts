import { JobCadence, JobStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { FREE_REVISION_WINDOW_DAYS } from '@/features/pricing/service-catalog';

// Human-triggered post-sale status transitions for a Job. Mirrors
// convert-to-client.service.ts's atomic-claim-via-`updateMany`-with-WHERE-
// on-current-state pattern and discriminated-outcome shape, substituting
// `Job` for `Prospect` and `active -> delivered`/`active -> monthly` for
// `!won -> won`.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const JOB_STATUS_SELECT = { id: true, cadence: true, status: true, statusHistory: true } as const;

export type MarkJobDeliveredOutcome =
  | { outcome: 'delivered'; deliveredAt: Date; freeRevisionWindowEndsAt: Date }
  | { outcome: 'not_found' }
  | { outcome: 'already_delivered' }
  // Wrong cadence (a recurring Job never "delivers" in this terminal sense)
  // or the Job isn't `active` (e.g. already `cancelled`).
  | { outcome: 'not_eligible' };

/**
 * Marks a one-off Job `active -> delivered`, setting `deliveredAt` to now and
 * `freeRevisionWindowEndsAt` to `deliveredAt + FREE_REVISION_WINDOW_DAYS`
 * (the catalog's "2 free fixes within 30 days of delivery" guarantee — see
 * service-catalog.ts). Idempotent: calling this again on an already-
 * `delivered` Job reports `already_delivered` rather than re-stamping
 * `deliveredAt`, which would otherwise silently reset the free-revision
 * window and the retention scheduler's day-3/14/30 touch schedule.
 */
export async function markJobDelivered(jobId: string): Promise<MarkJobDeliveredOutcome> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: JOB_STATUS_SELECT });
  if (!job) return { outcome: 'not_found' };

  if (job.cadence !== JobCadence.one_off) return { outcome: 'not_eligible' };
  if (job.status === JobStatus.delivered) return { outcome: 'already_delivered' };

  const statusHistory = Array.isArray(job.statusHistory) ? job.statusHistory : [];
  const deliveredAt = new Date();
  const freeRevisionWindowEndsAt = new Date(deliveredAt.getTime() + FREE_REVISION_WINDOW_DAYS * MS_PER_DAY);

  // Atomic claim: only succeeds if this Job is still exactly `active` (and
  // still `one_off`) at claim time — conditioned on the exact state just
  // read, same principle as convert-to-client.service.ts's claim.
  const claim = await prisma.job.updateMany({
    where: { id: jobId, status: JobStatus.active, cadence: JobCadence.one_off },
    data: {
      status: JobStatus.delivered,
      deliveredAt,
      freeRevisionWindowEndsAt,
      statusHistory: [...statusHistory, { status: JobStatus.delivered, timestamp: deliveredAt.toISOString() }],
    },
  });

  if (claim.count !== 1) {
    // Lost the race (or the read was stale) — re-check rather than guessing.
    const recheck = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (recheck?.status === JobStatus.delivered) return { outcome: 'already_delivered' };
    return { outcome: 'not_eligible' };
  }

  return { outcome: 'delivered', deliveredAt, freeRevisionWindowEndsAt };
}

export type MarkJobRecurringActiveOutcome =
  | { outcome: 'activated' }
  | { outcome: 'not_found' }
  | { outcome: 'already_active' }
  // Wrong cadence (a one-off Job never goes `monthly`) or the Job isn't
  // `active` (e.g. already `cancelled`).
  | { outcome: 'not_eligible' };

/**
 * Marks a recurring Job `active -> monthly` — the retainer "going live" for
 * the first time, after which it's eligible for the Phase 8 quarterly-only
 * retention cadence (see retention-scheduler.ts). No `deliveredAt`/
 * `freeRevisionWindowEndsAt` are set here: those are one-off-Job concepts a
 * retainer that never "delivers" in that terminal sense doesn't have.
 */
export async function markJobRecurringActive(jobId: string): Promise<MarkJobRecurringActiveOutcome> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: JOB_STATUS_SELECT });
  if (!job) return { outcome: 'not_found' };

  if (job.cadence !== JobCadence.recurring) return { outcome: 'not_eligible' };
  if (job.status === JobStatus.monthly) return { outcome: 'already_active' };

  const statusHistory = Array.isArray(job.statusHistory) ? job.statusHistory : [];
  const now = new Date();

  const claim = await prisma.job.updateMany({
    where: { id: jobId, status: JobStatus.active, cadence: JobCadence.recurring },
    data: {
      status: JobStatus.monthly,
      statusHistory: [...statusHistory, { status: JobStatus.monthly, timestamp: now.toISOString() }],
    },
  });

  if (claim.count !== 1) {
    const recheck = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (recheck?.status === JobStatus.monthly) return { outcome: 'already_active' };
    return { outcome: 'not_eligible' };
  }

  return { outcome: 'activated' };
}
