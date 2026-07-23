'use client';

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
// prospect has one, else the raw draft body — same "prefer humanized"
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
      return 'Skipped — daily cap reached';
    case 'skipped_do_not_contact':
      return 'Skipped — do not contact';
    case 'skipped_already_approved':
      return 'Skipped — already approved';
    case 'not_found':
      return 'Skipped — draft not found';
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
  const [actionError, setActionError] = useState<string | null>(null);
  // Bumped after every approval submission to re-trigger the load effect
  // below — approved/sent items must drop out of the (drafted-only) queue
  // on the server's next response, not just get patched locally.
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Deliberately no synchronous `setIsLoading(true)` here: `isLoading`
    // starts `true` for the initial load, and a refetch after an approval
    // (via `refreshIndex`) doesn't need to flash the loading state again —
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
        if (!cancelled) setLoadError('Failed to load the approval queue.');
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

    setActionError(null);
    setPendingDraftIds((prev) => new Set([...prev, ...draftIds]));

    try {
      const results = await submitApprovals(buildApprovalPayload(draftIds));
      setLastOutcomes((prev) => {
        const next = { ...prev };
        for (const result of results) next[result.draftId] = result;
        return next;
      });
      setRefreshIndex((prev) => prev + 1);
    } catch {
      setActionError('Failed to submit the approval request.');
    } finally {
      setPendingDraftIds((prev) => {
        const next = new Set(prev);
        for (const id of draftIds) next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Approval queue</h1>
        {capStatus ? (
          <p className="text-sm text-muted-foreground">
            {capStatus.domainVerified
              ? `${capStatus.sentToday} of ${capStatus.effectiveDailyCap} warmup-ramp sends used today.`
              : `${capStatus.sentToday} of ${capStatus.effectiveDailyCap} test-cap sends used today (domain not yet DNS-verified — sending is capped low until it is).`}
            {remainingToday === 0 ? ' No sends remain today.' : null}
          </p>
        ) : null}
      </div>

      {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
      {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={selected.size === 0 || pendingDraftIds.size > 0}
          onClick={() => approve([...selected])}
        >
          Approve selected ({selected.size})
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === selectableDraftIds().length}
                onChange={toggleSelectAll}
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
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground">
                No drafted prospects awaiting approval.
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => {
              const draftId = item.draft?.id;
              const isPending = draftId ? pendingDraftIds.has(draftId) : false;
              const outcome = draftId ? lastOutcomes[draftId] : undefined;
              const blocked = item.doNotContact || !item.draft;

              return (
                <TableRow key={item.prospectId}>
                  <TableCell>
                    {draftId ? (
                      <input
                        type="checkbox"
                        checked={selected.has(draftId)}
                        disabled={blocked}
                        onChange={() => toggleSelected(draftId)}
                        aria-label={`Select ${item.companyName}`}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell>{item.companyName}</TableCell>
                  <TableCell>
                    {item.contactName ?? '—'}
                    <br />
                    <span className="text-xs text-muted-foreground">{item.contactEmail ?? 'no email on file'}</span>
                  </TableCell>
                  <TableCell>{item.priorityScore}</TableCell>
                  <TableCell>{item.draft?.subject ?? '—'}</TableCell>
                  <TableCell>
                    {item.draft ? (
                      <textarea
                        className="w-80 rounded-md border border-input bg-background p-2 text-sm"
                        rows={4}
                        value={bodyFor(item)}
                        disabled={blocked}
                        onChange={(event) => updateBody(item.draft!.id, event.target.value)}
                      />
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {item.doNotContact ? (
                      <span className="text-destructive">Do not contact</span>
                    ) : outcome ? (
                      outcomeLabel(outcome)
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      disabled={blocked || isPending || (draftId ? pendingDraftIds.has(draftId) : true)}
                      onClick={() => draftId && approve([draftId])}
                    >
                      {isPending ? 'Approving…' : 'Approve'}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
