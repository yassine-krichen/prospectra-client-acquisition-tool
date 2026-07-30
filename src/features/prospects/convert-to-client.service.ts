import { Prisma, ProspectStatus as PrismaProspectStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';

// Turns a won Prospect into a Client, once. Mirrors
// followup-scheduler.ts's atomic-claim-via-`updateMany`-with-WHERE-on-
// current-state pattern, escalated to `$transaction` because this also
// needs to create the Client row atomically together with the claim (the
// scheduler only ever updates one row per attempt, so it never needed that
// escalation).

const PROSPECT_SELECT = {
  id: true,
  companyName: true,
  domain: true,
  contactName: true,
  contactTitle: true,
  contactEmail: true,
  industry: true,
  companySize: true,
  doNotContact: true,
  status: true,
  statusHistory: true,
} as const satisfies Prisma.ProspectSelect;

export type ConvertOutcome =
  | { outcome: 'converted'; clientId: string }
  | { outcome: 'not_found' }
  | { outcome: 'already_converted'; clientId: string }
  | { outcome: 'blocked_do_not_contact' };

/**
 * Converts a Prospect to a Client. Idempotent: a second call for a Prospect
 * that already has a Client returns `already_converted` with that Client's
 * id rather than creating a duplicate. `doNotContact` blocks conversion
 * regardless of `status` — a compliance decision, never overridden. A
 * `dead` prospect is NOT blocked — only `doNotContact` is — since a dead
 * lead can legitimately come back and convert later.
 */
export async function convertProspectToClient(prospectId: string): Promise<ConvertOutcome> {
  return prisma.$transaction(async (tx) => {
    const prospect = await tx.prospect.findUnique({ where: { id: prospectId }, select: PROSPECT_SELECT });
    if (!prospect) return { outcome: 'not_found' };

    const existingClient = await tx.client.findUnique({ where: { prospectId }, select: { id: true } });
    if (existingClient) return { outcome: 'already_converted', clientId: existingClient.id };

    if (prospect.doNotContact) return { outcome: 'blocked_do_not_contact' };

    const statusHistory = Array.isArray(prospect.statusHistory) ? prospect.statusHistory : [];
    const now = new Date();

    // Atomic claim: only succeeds if this prospect isn't already `won` and
    // is still contactable at claim time. Conditioned on the exact state
    // just read, same principle as followup-scheduler.ts's claims.
    const claim = await tx.prospect.updateMany({
      where: { id: prospectId, status: { not: PrismaProspectStatus.won }, doNotContact: false },
      data: {
        status: PrismaProspectStatus.won,
        statusHistory: [...statusHistory, { status: PrismaProspectStatus.won, timestamp: now.toISOString() }],
      },
    });

    if (claim.count !== 1) {
      // Lost the race. The winner must have created (or be in the middle of
      // creating) the Client in its own transaction — re-check rather than
      // silently succeeding or guessing.
      const raceWinnerClient = await tx.client.findUnique({ where: { prospectId }, select: { id: true } });
      if (raceWinnerClient) return { outcome: 'already_converted', clientId: raceWinnerClient.id };
      return { outcome: 'not_found' };
    }

    const client = await tx.client.create({
      data: {
        prospectId,
        companyName: prospect.companyName,
        domain: prospect.domain,
        contactName: prospect.contactName,
        contactTitle: prospect.contactTitle,
        contactEmail: prospect.contactEmail,
        industry: prospect.industry,
        companySize: prospect.companySize,
      },
      select: { id: true },
    });

    return { outcome: 'converted', clientId: client.id };
  });
}
