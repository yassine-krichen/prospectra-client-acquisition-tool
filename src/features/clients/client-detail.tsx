'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { clientSchema, type Client, type Job, type JobCadence, type JobStatus } from '@/features/clients/client.types';
import { CreateJobForm } from '@/features/clients/create-job-form';
import { toastError, toastSuccess } from '@/lib/toast';

const jobActionResponseSchema = z.object({
  outcome: z.enum(['delivered', 'already_delivered', 'not_eligible', 'activated', 'already_active']),
});

interface ClientDetailProps {
  clientId: string;
}

const JOB_STATUS_VARIANT: Record<JobStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  delivered: 'secondary',
  monthly: 'secondary',
  cancelled: 'destructive',
};

const JOB_ACTION_MESSAGE: Record<string, string> = {
  delivered: 'Marked as delivered.',
  already_delivered: 'Already marked delivered - no change made.',
  activated: 'Activated.',
  already_active: 'Already active - no change made.',
  not_eligible: "This Job isn't eligible for that transition right now.",
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatDate(value: Date | null): string {
  return value ? value.toLocaleDateString() : '-';
}

function formatCadence(cadence: JobCadence): string {
  return cadence === 'one_off' ? 'One-off' : 'Monthly';
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
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Deliberately no synchronous `setIsLoading(true)` here: `isLoading`
    // starts `true` for the initial load, and a refetch after a job action
    // (via `refreshIndex`) doesn't need to flash the loading state again -
    // the previous client data stays visible until the fresh copy arrives.
    fetchClient(clientId)
      .then((result) => {
        if (cancelled) return;
        setClient(result);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) {
          setError('Failed to load client.');
          toastError('Failed to load client', 'Check your connection and try refreshing.');
        }
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
      const message = JOB_ACTION_MESSAGE[outcome] ?? outcome;
      if (outcome === 'not_eligible') {
        toastError(`${job.service} - no change`, message);
      } else {
        toastSuccess(job.service, message);
      }
      setRefreshIndex((prev) => prev + 1);
    } catch (err) {
      toastError('Job action failed', err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setPendingJobIds((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !client) {
    // The actual failure reason (if any) was already shown as a toast when
    // it happened - this is just a neutral "nothing to show" fallback, not
    // a second error surface.
    return <p className="text-muted-foreground p-6 text-sm">{error ? 'Failed to load client.' : 'Client not found.'}</p>;
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <Link
        href="/clients"
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
        Clients
      </Link>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">{client.companyName}</CardTitle>
          {client.doNotContact ? <Badge variant="destructive">Do not contact</Badge> : null}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">Domain</dt>
              <dd>{client.domain ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Industry</dt>
              <dd className="capitalize">{client.industry.replace(/_/g, ' ')}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Company size</dt>
              <dd>{client.companySize}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Contact</dt>
              <dd>
                {client.contactName ?? '-'} {client.contactTitle ? `(${client.contactTitle})` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Contact email</dt>
              <dd>{client.contactEmail ?? '-'}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-foreground mb-2 text-sm font-medium">Jobs</h2>
        <div className="bg-card overflow-hidden rounded-xl ring-1 ring-foreground/10">
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
                  <TableCell colSpan={9} className="py-8 text-center">
                    <p className="text-foreground text-sm font-medium">No jobs yet</p>
                    <p className="text-muted-foreground text-sm">Sell one using the form below.</p>
                  </TableCell>
                </TableRow>
              ) : (
                client.jobs.map((job) => {
                  const isPending = pendingJobIds.has(job.id);
                  const canDeliver = job.cadence === 'one_off' && job.status === 'active';
                  const canActivate = job.cadence === 'recurring' && job.status === 'active';

                  return (
                    <TableRow key={job.id}>
                      <TableCell className="font-medium capitalize">{job.service.replace(/_/g, ' ')}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{formatCadence(job.cadence)}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={JOB_STATUS_VARIANT[job.status]} className="capitalize">
                          {job.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatCents(job.agreedPriceCents)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(job.soldAt)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(job.deliveredAt)}</TableCell>
                      <TableCell className="text-muted-foreground">{job.retainerDiscount ?? '-'}</TableCell>
                      <TableCell className="text-muted-foreground">{job.retentionTouchCount}</TableCell>
                      <TableCell>
                        {canDeliver ? (
                          <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleJobAction(job, 'deliver')}>
                            {isPending ? 'Working…' : 'Mark delivered'}
                          </Button>
                        ) : canActivate ? (
                          <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleJobAction(job, 'activate')}>
                            {isPending ? 'Working…' : 'Activate'}
                          </Button>
                        ) : (
                          <span className="text-muted-foreground text-xs"> - </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <CreateJobForm clientId={clientId} companySize={client.companySize} onCreated={() => setRefreshIndex((prev) => prev + 1)} />
    </div>
  );
}
