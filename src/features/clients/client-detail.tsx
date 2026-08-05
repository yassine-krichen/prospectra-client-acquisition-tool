'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { clientSchema, type Client, type Job } from '@/features/clients/client.types';
import { CreateJobForm } from '@/features/clients/create-job-form';

const jobActionResponseSchema = z.object({
  outcome: z.enum(['delivered', 'already_delivered', 'not_eligible', 'activated', 'already_active']),
});

interface ClientDetailProps {
  clientId: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatDate(value: Date | null): string {
  return value ? value.toLocaleDateString() : '—';
}

async function fetchClient(clientId: string): Promise<Client> {
  const response = await fetch(`/api/clients/${clientId}`);
  if (!response.ok) {
    throw new Error(`Failed to load client (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return clientSchema.parse((body as { client: unknown }).client);
}

async function runJobAction(clientId: string, jobId: string, action: 'deliver' | 'activate'): Promise<string> {
  const response = await fetch(`/api/clients/${clientId}/jobs/${jobId}/${action}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Job action failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return jobActionResponseSchema.parse(body).outcome;
}

export function ClientDetail({ clientId }: ClientDetailProps): React.JSX.Element {
  const [client, setClient] = useState<Client | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingJobIds, setPendingJobIds] = useState<Set<string>>(new Set());
  const [lastOutcomes, setLastOutcomes] = useState<Record<string, string>>({});
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Deliberately no synchronous `setIsLoading(true)` here: `isLoading`
    // starts `true` for the initial load, and a refetch after a job action
    // (via `refreshIndex`) doesn't need to flash the loading state again —
    // the previous client data stays visible until the fresh copy arrives.
    fetchClient(clientId)
      .then((result) => {
        if (cancelled) return;
        setClient(result);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load client.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clientId, refreshIndex]);

  async function handleJobAction(job: Job, action: 'deliver' | 'activate'): Promise<void> {
    setPendingJobIds((prev) => new Set(prev).add(job.id));
    try {
      const outcome = await runJobAction(clientId, job.id, action);
      setLastOutcomes((prev) => ({ ...prev, [job.id]: outcome }));
      setRefreshIndex((prev) => prev + 1);
    } catch {
      setLastOutcomes((prev) => ({ ...prev, [job.id]: 'request_failed' }));
    } finally {
      setPendingJobIds((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  }

  if (isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  if (error || !client) {
    return <p className="p-6 text-sm text-destructive">{error ?? 'Client not found.'}</p>;
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="rounded-md border border-border p-4">
        <h1 className="text-lg font-medium">{client.companyName}</h1>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Domain</dt>
          <dd>{client.domain ?? '—'}</dd>
          <dt className="text-muted-foreground">Industry</dt>
          <dd>{client.industry}</dd>
          <dt className="text-muted-foreground">Company size</dt>
          <dd>{client.companySize}</dd>
          <dt className="text-muted-foreground">Contact</dt>
          <dd>
            {client.contactName ?? '—'} {client.contactTitle ? `(${client.contactTitle})` : ''}
          </dd>
          <dt className="text-muted-foreground">Contact email</dt>
          <dd>{client.contactEmail ?? '—'}</dd>
          <dt className="text-muted-foreground">Do-not-contact</dt>
          <dd>{client.doNotContact ? 'Yes' : 'No'}</dd>
        </dl>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium">Jobs</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Cadence</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Sold at</TableHead>
              <TableHead>Delivered at</TableHead>
              <TableHead>Retainer discount</TableHead>
              <TableHead>Retention touches</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {client.jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  No jobs yet.
                </TableCell>
              </TableRow>
            ) : (
              client.jobs.map((job) => {
                const isPending = pendingJobIds.has(job.id);
                const outcome = lastOutcomes[job.id];
                const canDeliver = job.cadence === 'one_off' && job.status === 'active';
                const canActivate = job.cadence === 'recurring' && job.status === 'active';

                return (
                  <TableRow key={job.id}>
                    <TableCell>{job.service}</TableCell>
                    <TableCell>{job.cadence}</TableCell>
                    <TableCell>{job.status}</TableCell>
                    <TableCell>{formatCents(job.agreedPriceCents)}</TableCell>
                    <TableCell>{formatDate(job.soldAt)}</TableCell>
                    <TableCell>{formatDate(job.deliveredAt)}</TableCell>
                    <TableCell>{job.retainerDiscount ?? '—'}</TableCell>
                    <TableCell>{job.retentionTouchCount}</TableCell>
                    <TableCell>
                      {canDeliver ? (
                        <Button size="sm" disabled={isPending} onClick={() => handleJobAction(job, 'deliver')}>
                          {isPending ? 'Working…' : 'Mark delivered'}
                        </Button>
                      ) : canActivate ? (
                        <Button size="sm" disabled={isPending} onClick={() => handleJobAction(job, 'activate')}>
                          {isPending ? 'Working…' : 'Activate'}
                        </Button>
                      ) : (
                        '—'
                      )}
                      {outcome ? <p className="mt-1 text-xs text-muted-foreground">{outcome}</p> : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <CreateJobForm
        clientId={clientId}
        companySize={client.companySize}
        onCreated={() => setRefreshIndex((prev) => prev + 1)}
      />
    </div>
  );
}
