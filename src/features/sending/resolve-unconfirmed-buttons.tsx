'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';
import {
  resolveUnconfirmedResultSchema,
  type ResolveUnconfirmedRequest,
  type ResolveUnconfirmedResult,
} from '@/features/sending/sending.types';

interface ResolveUnconfirmedButtonsProps {
  prospectId: string;
  companyName: string;
  /** Called after the server accepted the answer, so the parent can refetch. */
  onResolved: () => void;
}

async function submitResolution(
  prospectId: string,
  outcome: ResolveUnconfirmedRequest['outcome']
): Promise<ResolveUnconfirmedResult> {
  const response = await fetch(`/api/prospects/${encodeURIComponent(prospectId)}/resolve-unconfirmed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome }),
  });
  if (!response.ok) {
    throw new Error(`Resolve request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return resolveUnconfirmedResultSchema.parse(body);
}

/**
 * The two answers to "did this unconfirmed email go out?". "Not delivered"
 * asks for confirmation first because a wrong answer lets the same email be
 * sent a second time; "It was delivered" is the safe direction and does not.
 */
export function ResolveUnconfirmedButtons({
  prospectId,
  companyName,
  onResolved,
}: ResolveUnconfirmedButtonsProps): React.JSX.Element {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function resolve(outcome: ResolveUnconfirmedRequest['outcome']): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await submitResolution(prospectId, outcome);
      if (result.outcome === 'send_in_progress') {
        toastInfo(`${companyName}: still sending`, 'The email may still go out. Try again in a few minutes.');
      } else if (result.outcome === 'tag_cleared_only') {
        toastInfo(`${companyName}: warning cleared`, 'The prospect had already moved on (replied or closed), so nothing was reverted.');
      } else if (result.outcome === 'nothing_to_resolve') {
        toastInfo(`${companyName}: nothing to resolve`, 'It was already resolved.');
      } else if (outcome === 'delivered') {
        toastSuccess(`${companyName}: marked as delivered`);
      } else {
        toastSuccess(`${companyName}: marked as not delivered`, 'It can be sent again.');
      }
      onResolved();
    } catch {
      toastError(`Failed to update ${companyName}.`, 'Nothing was changed - try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={isSubmitting} onClick={() => void resolve('delivered')}>
          It was delivered
        </Button>
        <Button size="sm" variant="destructive" disabled={isSubmitting} onClick={() => setConfirmOpen(true)}>
          Not delivered, allow resend
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Allow {companyName} to be sent again?</DialogTitle>
            <DialogDescription>
              Check the Resend dashboard first. If the email actually went out and you answer &quot;not
              delivered&quot;, the next send will email this prospect a duplicate.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isSubmitting}
              onClick={() => {
                setConfirmOpen(false);
                void resolve('not_delivered');
              }}
            >
              I checked, it was not delivered
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
