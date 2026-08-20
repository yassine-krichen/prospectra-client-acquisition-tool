'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, ClipboardListIcon, InboxIcon, SentIcon } from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';
import {
  approvalBatchResponseSchema,
  queueListResultSchema,
  type ApprovalOutcome,
  type QueueItemView,
  type QueueListResult,
} from '@/features/sending/sending.types';

async function fetchQueue(): Promise<QueueListResult> {
  const response = await fetch('/api/queue');
  if (!response.ok) {
    throw new Error(`Failed to load the approval queue (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return queueListResultSchema.parse(body);
}

async function submitApprovals(
  approvals: Array<{ draftId: string; editedBody?: string }>
): Promise<ApprovalOutcome[]> {
  const response = await fetch('/api/queue/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvals }),
  });

  if (!response.ok) {
    throw new Error(`Approval request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return approvalBatchResponseSchema.parse(body).results;
}

// The text a draft's textarea starts out showing: the humanized body if the
// prospect has one, else the raw draft body - same "prefer humanized"
// convention as pickDisplayDraft in queue-listing.ts.
function displayBody(item: QueueItemView): string {
  if (!item.draft) return '';
  return item.draft.humanizedBody ?? item.draft.body;
}

function outcomeLabel(outcome: ApprovalOutcome): string {
  switch (outcome.outcome) {
    case 'sent':
      return 'Sent';
    case 'failed':
      return `Failed: ${outcome.reason}`;
    case 'skipped_cap':
      return 'Skipped - daily cap reached';
    case 'skipped_do_not_contact':
      return 'Skipped - do not contact';
    case 'skipped_already_approved':
      return 'Skipped - already approved';
    case 'not_found':
      return 'Skipped - draft not found';
  }
}

function outcomeBadgeVariant(outcome: ApprovalOutcome): 'default' | 'destructive' | 'outline' {
  if (outcome.outcome === 'sent') return 'default';
  if (outcome.outcome === 'failed' || outcome.outcome === 'not_found') return 'destructive';
  return 'outline';
}

/**
 * Turns a just-submitted batch of approval outcomes into one toast: title
 * states the headline (N sent / N failed / N skipped), description lists
 * every affected company by name with its exact outcome - never collapsed
 * to a single generic "approved" message, since "sent" vs "failed and
 * rolled back" vs "blocked by the daily cap" are materially different
 * things a human approving real outbound email needs to actually see.
 */
function toastApprovalResults(results: ApprovalOutcome[], items: QueueItemView[]): void {
  const nameFor = (draftId: string): string =>
    items.find((item) => item.draft?.id === draftId)?.companyName ?? draftId;

  const description = results.map((result) => `${nameFor(result.draftId)}: ${outcomeLabel(result)}`).join('\n');

  const sentCount = results.filter((r) => r.outcome === 'sent').length;
  const failedCount = results.filter((r) => r.outcome === 'failed' || r.outcome === 'not_found').length;
  const skippedCount = results.length - sentCount - failedCount;

  const parts = [
    sentCount > 0 ? `${sentCount} sent` : null,
    failedCount > 0 ? `${failedCount} failed` : null,
    skippedCount > 0 ? `${skippedCount} skipped` : null,
  ].filter((part): part is string => part !== null);
  const title = parts.join(', ') || 'No approvals submitted';

  if (failedCount > 0) {
    toastError(title, description);
  } else if (sentCount > 0) {
    toastSuccess(title, description);
  } else {
    toastInfo(title, description);
  }
}

export function ApprovalQueueTable(): React.JSX.Element {
  const [items, setItems] = useState<QueueItemView[]>([]);
  const [capStatus, setCapStatus] = useState<QueueListResult['capStatus'] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editedBodies, setEditedBodies] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDraftIds, setPendingDraftIds] = useState<Set<string>>(new Set());
  const [lastOutcomes, setLastOutcomes] = useState<Record<string, ApprovalOutcome>>({});
  // Bumped after every approval submission to re-trigger the load effect
  // below - approved/sent items must drop out of the (drafted-only) queue
  // on the server's next response, not just get patched locally.
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Deliberately no synchronous `setIsLoading(true)` here: `isLoading`
    // starts `true` for the initial load, and a refetch after an approval
    // (via `refreshIndex`) doesn't need to flash the loading state again -
    // the previous items stay visible until the fresh ones arrive.
    fetchQueue()
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setCapStatus(result.capStatus);
        setLoadError(null);
        // Reset per-draft edit state to match whatever the server now
        // considers each draft's body.
        setEditedBodies({});
        setSelected(new Set());
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Failed to load the approval queue.');
          toastError('Failed to load the approval queue.');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshIndex]);

  const remainingToday = useMemo(() => {
    if (!capStatus) return null;
    return Math.max(capStatus.effectiveDailyCap - capStatus.sentToday, 0);
  }, [capStatus]);

  const capPercentUsed = useMemo(() => {
    if (!capStatus || capStatus.effectiveDailyCap <= 0) return 0;
    return Math.min((capStatus.sentToday / capStatus.effectiveDailyCap) * 100, 100);
  }, [capStatus]);

  function bodyFor(item: QueueItemView): string {
    if (!item.draft) return '';
    return editedBodies[item.draft.id] ?? displayBody(item);
  }

  function updateBody(draftId: string, value: string): void {
    setEditedBodies((prev) => ({ ...prev, [draftId]: value }));
  }

  function toggleSelected(draftId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(draftId)) next.delete(draftId);
      else next.add(draftId);
      return next;
    });
  }

  function selectableDraftIds(): string[] {
    return items.filter((item) => item.draft && !item.doNotContact).map((item) => item.draft!.id);
  }

  function toggleSelectAll(): void {
    const selectable = selectableDraftIds();
    setSelected((prev) => (prev.size === selectable.length ? new Set() : new Set(selectable)));
  }

  // Builds the approval payload for one or more draftIds, attaching
  // `editedBody` only for drafts a human actually changed from the value the
  // queue originally showed them.
  function buildApprovalPayload(draftIds: string[]): Array<{ draftId: string; editedBody?: string }> {
    return draftIds.map((draftId) => {
      const item = items.find((candidate) => candidate.draft?.id === draftId);
      const original = item ? displayBody(item) : undefined;
      const current = editedBodies[draftId];
      const wasEdited = current !== undefined && current !== original;
      return wasEdited ? { draftId, editedBody: current } : { draftId };
    });
  }

  async function approve(draftIds: string[]): Promise<void> {
    if (draftIds.length === 0) return;

    setPendingDraftIds((prev) => new Set([...prev, ...draftIds]));

    try {
      const results = await submitApprovals(buildApprovalPayload(draftIds));
      setLastOutcomes((prev) => {
        const next = { ...prev };
        for (const result of results) next[result.draftId] = result;
        return next;
      });
      toastApprovalResults(results, items);
      setRefreshIndex((prev) => prev + 1);
    } catch {
      toastError('Failed to submit the approval request.', 'Nothing was sent - try again.');
    } finally {
      setPendingDraftIds((prev) => {
        const next = new Set(prev);
        for (const id of draftIds) next.delete(id);
        return next;
      });
    }
  }

  const selectableCount = selectableDraftIds().length;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={ClipboardListIcon} strokeWidth={2} className="text-muted-foreground size-5" />
          <h1 className="text-lg font-semibold">Approval queue</h1>
        </div>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Approving a draft here sends a real email through Resend immediately - there is no separate
          confirmation step. Edit the body first if it needs changing; edits are saved as part of the same
          approval.
        </p>
      </div>

      {capStatus ? (
        <div className="bg-card flex max-w-md flex-col gap-1.5 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <HugeiconsIcon icon={SentIcon} strokeWidth={2} className="size-3.5" />
              Sends used today
            </span>
            <span className="text-muted-foreground">
              {capStatus.sentToday} / {capStatus.effectiveDailyCap}
            </span>
          </div>
          <Progress value={capPercentUsed} />
          <div className="flex items-center justify-between">
            <Badge variant={capStatus.domainVerified ? 'default' : 'outline'}>
              {capStatus.domainVerified ? 'Domain verified - warmup ramp cap' : 'Domain not verified - test cap'}
            </Badge>
            {remainingToday === 0 ? (
              <span className="text-destructive flex items-center gap-1 text-xs font-medium">
                <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5" />
                No sends remain today
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {loadError ? <p className="text-destructive text-sm">{loadError}</p> : null}

      <Separator />

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={selected.size === 0 || pendingDraftIds.size > 0}
          onClick={() => approve([...selected])}
        >
          Approve selected ({selected.size})
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-card flex flex-col items-center gap-3 rounded-lg py-16 text-center ring-1 ring-foreground/10">
          <HugeiconsIcon icon={InboxIcon} strokeWidth={1.5} className="text-muted-foreground size-10" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">Nothing waiting for approval</p>
            <p className="text-muted-foreground text-sm">
              Draft outreach for a prospect first - {' '}
              <Link href="/prospects" className="text-primary underline-offset-4 hover:underline">
                head to Prospects
              </Link>{' '}
              and hit Draft on one that&apos;s enriched.
            </p>
          </div>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Checkbox
                  checked={selected.size > 0 && selected.size === selectableCount}
                  disabled={selectableCount === 0}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Body</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const draftId = item.draft?.id;
              const isPending = draftId ? pendingDraftIds.has(draftId) : false;
              const outcome = draftId ? lastOutcomes[draftId] : undefined;
              const blocked = item.doNotContact || !item.draft;

              return (
                <TableRow key={item.prospectId}>
                  <TableCell>
                    {draftId ? (
                      <Checkbox
                        checked={selected.has(draftId)}
                        disabled={blocked}
                        onCheckedChange={() => toggleSelected(draftId)}
                        aria-label={`Select ${item.companyName}`}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell className="font-medium">{item.companyName}</TableCell>
                  <TableCell>
                    {item.contactName ?? '-'}
                    <br />
                    <span className="text-muted-foreground text-xs">{item.contactEmail ?? 'no email on file'}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{item.priorityScore}</Badge>
                  </TableCell>
                  <TableCell>{item.draft?.subject ?? '-'}</TableCell>
                  <TableCell>
                    {item.draft ? (
                      <textarea
                        className="border-input bg-background w-80 rounded-md border p-2 text-sm"
                        rows={4}
                        value={bodyFor(item)}
                        disabled={blocked}
                        onChange={(event) => updateBody(item.draft!.id, event.target.value)}
                      />
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {item.doNotContact ? (
                      <Badge variant="destructive">Do not contact</Badge>
                    ) : outcome ? (
                      <Badge variant={outcomeBadgeVariant(outcome)}>{outcomeLabel(outcome)}</Badge>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      disabled={blocked || isPending}
                      onClick={() => draftId && approve([draftId])}
                    >
                      {isPending ? 'Approving…' : 'Approve'}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
