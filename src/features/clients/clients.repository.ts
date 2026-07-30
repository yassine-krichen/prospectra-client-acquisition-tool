import { Prisma } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { fromPrismaCompanySize } from '@/features/prospects/company-size.mapper';
import type { Client, Job } from '@/features/clients/client.types';

// Explicit projection — no `SELECT *` — matching prospects.repository.ts's
// convention (see "Explicit data selection" in engineering standards).
const CLIENT_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  prospectId: true,
  companyName: true,
  domain: true,
  contactName: true,
  contactTitle: true,
  contactEmail: true,
  industry: true,
  companySize: true,
  doNotContact: true,
  notes: true,
  statusHistory: true,
  jobs: true,
} as const satisfies Prisma.ClientSelect;

type ClientRow = Prisma.ClientGetPayload<{ select: typeof CLIENT_SELECT }>;

function toClient(row: ClientRow): Client {
  return {
    ...row,
    companySize: fromPrismaCompanySize(row.companySize),
    statusHistory: row.statusHistory as unknown as Client['statusHistory'],
    jobs: row.jobs.map(
      (job): Job => ({
        ...job,
        statusHistory: job.statusHistory as unknown as Job['statusHistory'],
      })
    ),
  };
}

/** Single Client with its full Job history, or `null` if no Client exists with this id. */
export async function getClientWithJobs(clientId: string): Promise<Client | null> {
  const row = await prisma.client.findUnique({ where: { id: clientId }, select: CLIENT_SELECT });
  return row ? toClient(row) : null;
}

/**
 * All Clients with their Jobs, newest first. No pagination/filtering yet —
 * deferred until the dashboard Clients list (or a later phase) actually
 * needs it, per "don't over-build."
 */
export async function listClients(): Promise<Client[]> {
  const rows = await prisma.client.findMany({ select: CLIENT_SELECT, orderBy: { createdAt: 'desc' } });
  return rows.map(toClient);
}
