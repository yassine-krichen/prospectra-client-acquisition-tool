'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Alert02Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  ClipboardListIcon,
  InboxIcon,
  SentIcon,
} from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';
import {
  approvalBatchResponseSchema,
  queueListResultSchema,
  type ApprovalOutcome,
  type QueueDraftView,
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

// The text a draft variant's textarea starts out showing: the humanized body
// if this variant has one, else its raw draft body - same "prefer humanized"
// convention as pickDisplayDraft in queue-listing.ts.
function displayBody(draft: QueueDraftView): string {
  return draft.humanizedBody ?? draft.body;
}

// `Draft.framework` is a plain lowercase/underscored id (e.g. "social_proof",
// see prompt-templates.ts's FrameworkId) - this is purely cosmetic
// title-casing for display, not a mapping back to prompt-templates.ts (which
// isn't safe to import from a client component - see queue-listing.ts's
// comment on why `framework` crosses the wire as a plain nullable string).
function frameworkLabel(framework: string | null): string {
  if (!framework) return 'Variant';
  return framework
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

function outcomeIcon(outcome: ApprovalOutcome): typeof CheckmarkCircle02Icon {
  if (outcome.outcome === 'sent') return CheckmarkCircle02Icon;
  if (outcome.outcome === 'failed' || outcome.outcome === 'not_found') return AlertCircleIcon;
  return Alert02Icon;
}

// prospectId -> its default (pre-selected) draft, falling back to the first
// variant if the server somehow didn't nominate one but drafts exist.
function initialChosenDraftIds(items: QueueItemView[]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const item of items) {
    const chosen = item.defaultDraftId ?? item.drafts[0]?.id;
    if (chosen) next[item.prospectId] = chosen;
  }
  return next;
}

/**
 * Turns a just-submitted batch of approval outcomes into one toast: title
 * states the headline (N sent / N failed / N skipped), description lists
 * every affected company by name with its exact outcome - never collapsed
 * to a single generic "approved" message, since "sent" vs "failed and
 * rolled back" vs "blocked by the daily cap" are materially different
 * things a human approving real outbound email needs to actually see.
 */
function toastApprovalResults(
  results: ApprovalOutcome[],
  companyNameByDraftId: Map<string, string>
): void {
  const nameFor = (draftId: string): string => companyNameByDraftId.get(draftId) ?? draftId;

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

  const [editedBodies, setEditedBodies] = useState<Record<string, string>>({});
  // Which draft variant is currently highlighted/chosen per prospect - what
  // a radio-button selection inside each card controls. Defaults to
  // `defaultDraftId` (pickDisplayDraft's pick) on every load.
  const [chosenDraftId, setChosenDraftId] = useState<Record<string, string>>({});
  // Which prospects (by prospectId) are checked for the bulk "Approve
  // selected" action - resolved to a draftId via `chosenDraftId` at submit
  // time, so bulk-approving always sends whichever variant is currently
  // highlighted for that prospect.
  const [selectedProspects, setSelectedProspects] = useState<Set<string>>(new Set());
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
        // Reset per-draft edit/selection state to match whatever the server
        // now considers each prospect's drafts.
        setEditedBodies({});
        setSelectedProspects(new Set());
        setChosenDraftId(initialChosenDraftIds(result.items));
      })
      .catch(() => {
        if (!cancelled) toastError('Failed to load the approval queue.');
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

  // Flat draftId -> company name lookup, used by the post-submit toast -
  // company name lives on the parent QueueItemView, not the draft itself.
  const companyNameByDraftId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      for (const draft of item.drafts) map.set(draft.id, item.companyName);
    }
    return map;
  }, [items]);

  function bodyFor(draft: QueueDraftView): string {
    return editedBodies[draft.id] ?? displayBody(draft);
  }

  function updateBody(draftId: string, value: string): void {
    setEditedBodies((prev) => ({ ...prev, [draftId]: value }));
  }

  function selectVariant(prospectId: string, draftId: string): void {
    setChosenDraftId((prev) => ({ ...prev, [prospectId]: draftId }));
  }

  function toggleProspectSelected(prospectId: string): void {
    setSelectedProspects((prev) => {
      const next = new Set(prev);
      if (next.has(prospectId)) next.delete(prospectId);
      else next.add(prospectId);
      return next;
    });
  }

  function selectableProspectIds(): string[] {
    return items.filter((item) => item.drafts.length > 0 && !item.doNotContact).map((item) => item.prospectId);
  }

  function toggleSelectAll(): void {
    const selectable = selectableProspectIds();
    setSelectedProspects((prev) => (prev.size === selectable.length ? new Set() : new Set(selectable)));
  }

  // Builds the approval payload for one or more draftIds, attaching
  // `editedBody` only for drafts a human actually changed from the value the
  // queue originally showed them.
  function buildApprovalPayload(draftIds: string[]): Array<{ draftId: string; editedBody?: string }> {
    return draftIds.map((draftId) => {
      const draft = items.flatMap((item) => item.drafts).find((candidate) => candidate.id === draftId);
      const original = draft ? displayBody(draft) : undefined;
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
      toastApprovalResults(results, companyNameByDraftId);
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

  // Resolves each selected prospect to its currently-chosen variant's
  // draftId, then approves all of them in one batch.
  function approveSelected(): void {
    const draftIds = [...selectedProspects]
      .map((prospectId) => chosenDraftId[prospectId])
      .filter((draftId): draftId is string => draftId !== undefined);
    void approve(draftIds);
  }

  const selectableCount = selectableProspectIds().length;

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
              {capStatus.domainVerified ? 'Domain verified - warmup ramp cap' : 'DOMAIN NOT VERIFIED'}
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

      <Separator />

      <div className="flex items-center gap-2">
        <Checkbox
          checked={selectedProspects.size > 0 && selectedProspects.size === selectableCount}
          disabled={selectableCount === 0}
          onCheckedChange={toggleSelectAll}
          aria-label="Select all"
        />
        <span className="text-muted-foreground text-sm">Select all</span>
        <Button
          variant="outline"
          disabled={selectedProspects.size === 0 || pendingDraftIds.size > 0}
          onClick={approveSelected}
        >
          Approve selected ({selectedProspects.size})
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
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
        <div className="flex flex-col gap-4">
          {items.map((item) => {
            const blocked = item.doNotContact || item.drafts.length === 0;
            const selectedVariantId = chosenDraftId[item.prospectId];

            return (
              <div key={item.prospectId} className="bg-card flex flex-col gap-3 rounded-lg p-4 ring-1 ring-foreground/10">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedProspects.has(item.prospectId)}
                      disabled={blocked}
                      onCheckedChange={() => toggleProspectSelected(item.prospectId)}
                      aria-label={`Select ${item.companyName}`}
                      className="mt-1"
                    />
                    <div className="flex flex-col">
                      <span className="font-medium">{item.companyName}</span>
                      <span className="text-muted-foreground text-xs">
                        {item.contactName ?? '-'} - {item.contactEmail ?? 'no email on file'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Priority {item.priorityScore}</Badge>
                    {item.doNotContact ? (
                      <Badge variant="destructive">
                        <HugeiconsIcon icon={AlertCircleIcon} data-icon="inline-start" strokeWidth={2} />
                        Do not contact
                      </Badge>
                    ) : null}
                  </div>
                </div>

                {item.drafts.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No drafts on file for this prospect.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {item.drafts.map((draft) => {
                      const isChosen = draft.id === selectedVariantId;
                      const isPending = pendingDraftIds.has(draft.id);
                      const outcome = lastOutcomes[draft.id];

                      return (
                        <div
                          key={draft.id}
                          className={`flex flex-col gap-2 rounded-md border p-3 ${
                            isChosen ? 'border-primary ring-1 ring-primary' : 'border-input'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <label className="flex items-center gap-1.5 text-sm font-medium">
                              <input
                                type="radio"
                                name={`variant-${item.prospectId}`}
                                checked={isChosen}
                                disabled={blocked}
                                onChange={() => selectVariant(item.prospectId, draft.id)}
                              />
                              {frameworkLabel(draft.framework)}
                            </label>
                            {draft.hasSendFailure ? <Badge variant="destructive">Send failed</Badge> : null}
                          </div>

                          <p className="text-sm font-medium">{draft.subject}</p>

                          <textarea
                            className="border-input bg-background w-full flex-1 rounded-md border p-2 text-sm"
                            rows={8}
                            value={bodyFor(draft)}
                            disabled={blocked}
                            onChange={(event) => updateBody(draft.id, event.target.value)}
                          />

                          {outcome ? (
                            <Badge variant={outcomeBadgeVariant(outcome)}>
                              <HugeiconsIcon icon={outcomeIcon(outcome)} data-icon="inline-start" strokeWidth={2} />
                              {outcomeLabel(outcome)}
                            </Badge>
                          ) : null}

                          <Button
                            size="sm"
                            disabled={blocked || isPending}
                            onClick={() => approve([draft.id])}
                          >
                            {isPending ? 'Approving…' : 'Approve this variant'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
