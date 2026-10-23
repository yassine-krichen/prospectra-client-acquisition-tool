'use client';

import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, AlertCircleIcon, InboxIcon, MailSend01Icon } from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';
import { ResolveUnconfirmedButtons } from '@/features/sending/resolve-unconfirmed-buttons';
import {
  MAX_FOLLOWUP_APPROVALS_PER_REQUEST,
  followupApprovalResponseSchema,
  followupQueueResultSchema,
  type FollowupApprovalOutcome,
  type FollowupQueueResult,
} from '@/features/followups/followup-approval.types';

async function fetchFollowupQueue(): Promise<FollowupQueueResult> {
  const response = await fetch('/api/queue/followups');
  if (!response.ok) {
    throw new Error(`Failed to load follow-ups (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return followupQueueResultSchema.parse(body);
}

async function submitFollowupApprovals(prospectIds: string[]): Promise<FollowupApprovalOutcome[]> {
  const response = await fetch('/api/queue/followups/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prospectIds }),
  });
  if (!response.ok) {
    throw new Error(`Follow-up approval failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return followupApprovalResponseSchema.parse(body).results;
}

function outcomeLabel(outcome: FollowupApprovalOutcome): string {
  switch (outcome.outcome) {
    case 'sent':
      return 'Sent';
    case 'failed':
      return `Failed: ${outcome.reason}`;
    case 'skipped_cap':
      return 'Skipped - daily cap reached';
    case 'skipped_not_eligible':
      return 'Skipped - no longer due (replied, opted out, or already followed up)';
  }
}

// Same shape as the first-touch queue's toast: a headline count plus one line
// per company with its exact outcome, never a generic "approved".
function toastFollowupResults(results: FollowupApprovalOutcome[], companyNameById: Map<string, string>): void {
  const description = results
    .map((result) => `${companyNameById.get(result.prospectId) ?? result.prospectId}: ${outcomeLabel(result)}`)
    .join('\n');

  const sentCount = results.filter((r) => r.outcome === 'sent').length;
  const failedCount = results.filter((r) => r.outcome === 'failed').length;
  const skippedCount = results.length - sentCount - failedCount;

  const title =
    [
      sentCount > 0 ? `${sentCount} sent` : null,
      failedCount > 0 ? `${failedCount} failed` : null,
      skippedCount > 0 ? `${skippedCount} skipped` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(', ') || 'No follow-ups submitted';

  if (failedCount > 0) toastError(title, description);
  else if (sentCount > 0) toastSuccess(title, description);
  else toastInfo(title, description);
}

export function FollowupApprovalTable(): React.JSX.Element {
  const [queue, setQueue] = useState<FollowupQueueResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  // Bumped after every approval or resolution to re-run the load effect: sent
  // follow-ups must drop off the (computed) due list on the server's next
  // response, not just be patched locally.
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    fetchFollowupQueue()
      .then((result) => {
        if (cancelled) return;
        setQueue(result);
        setSelected(new Set());
      })
      .catch(() => {
        if (!cancelled) toastError('Failed to load follow-ups.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshIndex]);

  const due = useMemo(() => queue?.due ?? [], [queue]);
  const companyNameById = useMemo(() => new Map(due.map((item) => [item.prospectId, item.companyName])), [due]);

  function toggleSelected(prospectId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(prospectId)) next.delete(prospectId);
      else next.add(prospectId);
      return next;
    });
  }

  // One request sends at most MAX_FOLLOWUP_APPROVALS_PER_REQUEST emails, so
  // "select all" takes the highest-priority ones up to that limit.
  const selectableIds = due.slice(0, MAX_FOLLOWUP_APPROVALS_PER_REQUEST).map((item) => item.prospectId);

  function toggleSelectAll(): void {
    setSelected((prev) => (prev.size === selectableIds.length ? new Set() : new Set(selectableIds)));
  }

  async function approve(prospectIds: string[]): Promise<void> {
    if (prospectIds.length === 0) return;

    setPendingIds((prev) => new Set([...prev, ...prospectIds]));
    try {
      const results = await submitFollowupApprovals(prospectIds);
      toastFollowupResults(results, companyNameById);
      setRefreshIndex((prev) => prev + 1);
    } catch {
      toastError('Failed to submit the follow-up approval.', 'Nothing was sent - try again.');
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        for (const id of prospectIds) next.delete(id);
        return next;
      });
    }
  }

  const unconfirmed = queue?.unconfirmed ?? [];

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={MailSend01Icon} strokeWidth={2} className="text-muted-foreground size-5" />
          <h2 className="text-lg font-semibold">Follow-ups</h2>
        </div>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Prospects whose first email has gone unanswered for the full follow-up interval. Approving sends the
          email shown, immediately, and counts toward today&apos;s send cap.
        </p>
      </div>

      {queue ? (
        queue.approvalRequired ? (
          <div className="bg-card flex max-w-2xl items-start gap-2 rounded-lg p-3 text-sm ring-1 ring-foreground/10">
            <Badge variant="default">Approval required</Badge>
            <span>Follow-ups wait here until you approve them. The scheduler will not send them by itself.</span>
          </div>
        ) : (
          <div className="bg-card flex max-w-2xl items-start gap-2 rounded-lg p-3 text-sm ring-1 ring-destructive/40">
            <Badge variant="destructive">
              <HugeiconsIcon icon={Alert02Icon} data-icon="inline-start" strokeWidth={2} />
              Approval off
            </Badge>
            <span>
              Follow-ups send automatically on the next scheduler run (limited by the batch size and the daily cap).
              Anything listed below will go out then unless you act first.
            </span>
          </div>
        )
      ) : null}

      <div className="flex items-center gap-2">
        <Checkbox
          checked={selectableIds.length > 0 && selected.size === selectableIds.length}
          disabled={due.length === 0}
          onCheckedChange={toggleSelectAll}
          aria-label="Select all follow-ups"
        />
        <span className="text-muted-foreground text-sm">
          {due.length > selectableIds.length ? `Select first ${selectableIds.length}` : 'Select all'}
        </span>
        <Button
          variant="outline"
          disabled={selected.size === 0 || selected.size > MAX_FOLLOWUP_APPROVALS_PER_REQUEST || pendingIds.size > 0}
          onClick={() => void approve([...selected])}
        >
          Approve and send selected ({selected.size})
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : due.length === 0 ? (
        <div className="bg-card flex flex-col items-center gap-3 rounded-lg py-12 text-center ring-1 ring-foreground/10">
          <HugeiconsIcon icon={InboxIcon} strokeWidth={1.5} className="text-muted-foreground size-10" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">No follow-ups waiting</p>
            <p className="text-muted-foreground text-sm">
              A prospect appears here once its first email has gone unanswered for the follow-up interval.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {due.map((item) => (
            <div key={item.prospectId} className="bg-card flex flex-col gap-3 rounded-lg p-4 ring-1 ring-foreground/10">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={selected.has(item.prospectId)}
                    onCheckedChange={() => toggleSelected(item.prospectId)}
                    aria-label={`Select ${item.companyName}`}
                    className="mt-1"
                  />
                  <div className="flex flex-col">
                    <span className="font-medium">{item.companyName}</span>
                    <span className="text-muted-foreground text-xs">{item.contactEmail}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">Priority {item.priorityScore}</Badge>
                  <Badge variant="outline">{item.daysSinceLastTouch} days since last touch</Badge>
                </div>
              </div>

              <div className="flex flex-col gap-1 rounded-md border p-3">
                <p className="text-sm font-medium">{item.subject}</p>
                <p className="text-muted-foreground text-sm whitespace-pre-wrap">{item.body}</p>
              </div>

              <div>
                <Button size="sm" disabled={pendingIds.has(item.prospectId)} onClick={() => void approve([item.prospectId])}>
                  {pendingIds.has(item.prospectId) ? 'Sending…' : 'Approve and send'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {unconfirmed.length > 0 ? (
        <>
          <Separator />
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} className="text-destructive size-5" />
              <h3 className="font-semibold">Unconfirmed follow-ups</h3>
            </div>
            <p className="text-muted-foreground max-w-2xl text-sm">
              These follow-ups timed out or got an unclear response, so they may already have gone out. They are not
              retried automatically. Check the Resend dashboard, then say what you found.
            </p>
            {unconfirmed.map((item) => (
              <div
                key={item.prospectId}
                className="bg-card flex flex-col gap-2 rounded-lg p-4 ring-1 ring-foreground/10"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{item.companyName}</span>
                  <span className="text-muted-foreground text-xs">
                    {item.contactEmail ?? 'no email on file'}
                    {item.lastFollowupAt ? ` - attempted ${new Date(item.lastFollowupAt).toLocaleString()}` : ''}
                  </span>
                </div>
                <ResolveUnconfirmedButtons
                  prospectId={item.prospectId}
                  companyName={item.companyName}
                  onResolved={() => setRefreshIndex((prev) => prev + 1)}
                />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
