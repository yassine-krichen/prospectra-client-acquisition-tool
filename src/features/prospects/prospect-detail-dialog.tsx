'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { HugeiconsIcon } from '@hugeicons/react';
import { Loading03Icon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toastError, toastInfo, toastSourceResults, toastSuccess } from '@/lib/toast';
import {
  deleteProspect,
  draftProspect,
  enrichProspect,
  getProspectDetail,
  matchProspect,
  winProspect,
} from '@/features/prospects/prospect-actions';
import type { Prospect } from '@/features/prospects/prospect.types';

interface ProspectDetailDialogProps {
  prospectId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Called after any action here succeeds, so the caller can refresh the underlying list/table. */
  onChanged: () => void;
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground text-right">{value}</span>
    </div>
  );
}

function formatDate(value: Date | string | null): string {
  if (!value) return 'None';
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString();
}

// Turns a snake_case enum value into readable English - "ai_agent" becomes
// "Ai agent". Mirrors `formatEnumLabel` in prospects-table.tsx (duplicated
// rather than imported - both are small client-safe helpers local to their
// own file, matching this repo's existing convention).
function formatEnumLabel(value: string): string {
  return value
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

interface ActionCardProps {
  title: string;
  description: string;
  buttonLabel: string;
  onClick: () => void;
  disabled: boolean;
}

function ActionCard({ title, description, buttonLabel, onClick, disabled }: ActionCardProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-xl border p-4 text-center">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{title}</span>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <Button onClick={onClick} disabled={disabled} className="self-center" size="sm">
        {disabled ? <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-3.5 animate-spin" /> : null}
        {buttonLabel}
      </Button>
    </div>
  );
}

export function ProspectDetailDialog({ prospectId, onOpenChange, onChanged }: ProspectDetailDialogProps): React.JSX.Element {
  return (
    <Dialog open={prospectId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {/* Keyed by prospectId so switching to a different prospect remounts
            this subtree - a fresh component instance with its own initial
            state, rather than an effect that has to detect the id change and
            manually reset `prospect`/`wonClientId` back to null itself. */}
        {prospectId ? (
          <ProspectDetailContent key={prospectId} prospectId={prospectId} onChanged={onChanged} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface ProspectDetailContentProps {
  prospectId: string;
  onChanged: () => void;
  onOpenChange: (open: boolean) => void;
}

function ProspectDetailContent({ prospectId, onChanged, onOpenChange }: ProspectDetailContentProps): React.JSX.Element {
  const [prospect, setProspect] = useState<Prospect | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPending, setIsPending] = useState(false);
  const [wonClientId, setWonClientId] = useState<string | null>(null);
  // Bumped after any action below succeeds, to re-trigger the fetch effect.
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Deliberately no synchronous `setIsLoading(true)` here: `isLoading`
    // starts `true` for the initial fetch, and a refresh after an action
    // (via `refreshIndex`) doesn't need to flash the skeleton again - the
    // previous detail stays visible until the fresh copy arrives.
    getProspectDetail(prospectId)
      .then((data) => {
        if (cancelled) return;
        setProspect(data);
        setLoadError(null);
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load this prospect.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [prospectId, refreshIndex]);

  async function runAction(action: () => Promise<void>): Promise<void> {
    setIsPending(true);
    try {
      await action();
      onChanged();
      setRefreshIndex((prev) => prev + 1);
    } catch (err) {
      toastError('Action failed', err instanceof Error ? err.message : 'Unknown error.');
    } finally {
      setIsPending(false);
    }
  }

  function handleEnrich(): void {
    void runAction(async () => {
      const result = await enrichProspect(prospectId);
      toastSourceResults('Enrichment', result.sources);
      if (result.downgradeSkipped) {
        toastInfo(
          'Kept existing contact',
          `${result.downgradeSkipped.reason} (existing confidence ${result.downgradeSkipped.existingConfidence}, attempted ${result.downgradeSkipped.attemptedConfidence})`
        );
      }
    });
  }

  function handleDraft(): void {
    void runAction(async () => {
      const result = await draftProspect(prospectId);
      if (result.ok) {
        const variantLabel = `${result.drafts.length} variant${result.drafts.length === 1 ? '' : 's'}`;
        const humanizeNote = result.humanize.attempted
          ? `Humanizer: ${result.humanize.outcome ?? 'attempted'}${result.humanize.reason ? `, ${result.humanize.reason}` : ''}`
          : undefined;
        toastSuccess(`Drafted ${variantLabel}`, humanizeNote);
      } else {
        toastError(`Draft flagged: ${result.flagged.replace(/_/g, ' ')}`, result.message);
      }
    });
  }

  function handleMatch(): void {
    void runAction(async () => {
      const result = await matchProspect(prospectId);
      if (result.outcome === 'applied') {
        const count = result.suggestedServices.length;
        toastSuccess(`Matched ${count} suggestion${count === 1 ? '' : 's'}`);
      } else {
        toastError('Invalid signal', result.reason);
      }
    });
  }

  function handleWin(): void {
    void runAction(async () => {
      const result = await winProspect(prospectId);
      switch (result.outcome) {
        case 'converted':
          setWonClientId(result.clientId);
          toastSuccess('Converted to client');
          break;
        case 'already_converted':
          setWonClientId(result.clientId);
          toastInfo('Already converted to a client');
          break;
        case 'blocked_do_not_contact':
          toastError('Cannot convert', 'This prospect is marked do-not-contact.');
          break;
        case 'not_found':
          toastError('Prospect not found', 'It may have been removed since this page loaded.');
          break;
      }
    });
  }

  // Deliberately NOT routed through `runAction` (which bumps `refreshIndex`
  // to refetch this prospect on success) - after a delete, the prospect no
  // longer exists, so refetching would 404 and flash a "not found" error
  // before the dialog gets a chance to close. Close first, then let the
  // caller's `onChanged` refresh the underlying table.
  function handleDelete(): void {
    setIsDeleting(true);
    deleteProspect(prospectId)
      .then((result) => {
        if ('outcome' in result && result.outcome === 'blocked_do_not_contact') {
          toastError('Cannot delete', 'This prospect is marked do-not-contact.');
          return;
        }
        toastSuccess('Prospect deleted');
        onOpenChange(false);
        onChanged();
      })
      .catch((err: unknown) => {
        toastError('Delete failed', err instanceof Error ? err.message : 'Unknown error.');
      })
      .finally(() => {
        setIsDeleting(false);
      });
  }

  const isEnriched = Boolean(prospect && (prospect.contactEmail || prospect.contactName));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{prospect?.companyName ?? 'Prospect'}</DialogTitle>
      </DialogHeader>

      {loadError ? <p className="text-destructive text-sm">{loadError}</p> : null}

      {isLoading || !prospect ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <DetailRow label="Domain" value={prospect.domain ?? 'None'} />
            <DetailRow label="Industry" value={prospect.industry} />
            <DetailRow label="Source" value={formatEnumLabel(prospect.source)} />
            <DetailRow label="Priority" value={prospect.priorityScore} />
            <DetailRow label="Discovered" value={formatDate(prospect.discoveredAt)} />
            <DetailRow
              label="Email verified"
              value={<Badge variant={prospect.emailVerified ? 'default' : 'outline'}>{prospect.emailVerified ? 'Yes' : 'No'}</Badge>}
            />
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Enrichment</span>
            {isEnriched ? (
              <div className="flex flex-col gap-2">
                <DetailRow label="Contact name" value={prospect.contactName ?? 'None'} />
                <DetailRow label="Contact title" value={prospect.contactTitle ?? 'None'} />
                <DetailRow label="Contact email" value={prospect.contactEmail ?? 'None'} />
                <DetailRow label="Email confidence" value={`${prospect.emailConfidence}/100`} />
                <DetailRow
                  label="LinkedIn"
                  value={
                    prospect.linkedinUrl ? (
                      <a href={prospect.linkedinUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                        Profile
                      </a>
                    ) : (
                      'None'
                    )
                  }
                />
                <DetailRow label="Do not contact" value={prospect.doNotContact ? 'Yes' : 'No'} />
                <DetailRow label="Replied" value={prospect.repliedAt ? `${formatDate(prospect.repliedAt)} (${prospect.replySentiment ?? 'unknown'})` : 'No'} />
                <DetailRow label="Follow-ups sent" value={prospect.followupCount} />
                <DetailRow label="Drafts" value={prospect.drafts.length} />
                {prospect.notes ? <DetailRow label="Notes" value={prospect.notes} /> : null}
                {prospect.tags.length > 0 ? <DetailRow label="Tags" value={prospect.tags.join(', ')} /> : null}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Not enriched.</p>
            )}
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Actions</span>
            <div className="grid grid-cols-2 gap-3">
              <ActionCard
                title="Enrich"
                description="Find a verified contact email - tries Hunter.io first, then People Data Labs, then a pattern-guessed address."
                buttonLabel="Enrich"
                onClick={handleEnrich}
                disabled={isPending}
              />
              <ActionCard
                title="Draft"
                description="Generate three AI-written outreach email variants tailored to this prospect's signal."
                buttonLabel="Draft"
                onClick={handleDraft}
                disabled={isPending}
              />
              <ActionCard
                title="Match"
                description="Recompute which services best fit this prospect's signal, company size, and industry."
                buttonLabel="Match"
                onClick={handleMatch}
                disabled={isPending}
              />
              <ActionCard
                title="Win"
                description="Mark this prospect as won and convert it into a paying client."
                buttonLabel="Win"
                onClick={handleWin}
                disabled={isPending}
              />
            </div>
            {wonClientId ? (
              <Link href={`/clients/${wonClientId}`} className="text-primary text-center text-sm underline">
                View client
              </Link>
            ) : null}
          </div>

          <Separator />

          <div className="flex flex-col items-start gap-1">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={isPending || isDeleting || prospect.doNotContact}
              title={prospect.doNotContact ? 'Cannot delete a do-not-contact prospect.' : undefined}
            >
              Delete prospect
            </Button>
            {prospect.doNotContact ? (
              <p className="text-muted-foreground text-xs">
                This prospect is marked do-not-contact and cannot be deleted, so the opt-out is never lost.
              </p>
            ) : null}
          </div>
        </div>
      )}

      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {prospect?.companyName ?? 'this prospect'}?</DialogTitle>
            <DialogDescription>
              This will permanently delete this prospect and all of its drafts and history. This cannot be undone.
              {wonClientId ? ' This prospect has been converted to a Client - deleting it will permanently remove that link (the Client itself is not deleted).' : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={() => {
                setConfirmDeleteOpen(false);
                handleDelete();
              }}
            >
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
