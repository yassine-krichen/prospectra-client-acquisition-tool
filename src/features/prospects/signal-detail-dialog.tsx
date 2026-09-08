'use client';

import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, AlertCircleIcon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Signal, SignalStrength } from '@/features/prospects/prospect.types';

// Turns a snake_case enum value into readable English - "no_https" becomes
// "No https". Mirrors `formatEnumLabel` in prospects-table.tsx (duplicated
// rather than imported - a small client-safe helper local to its own file,
// matching this repo's existing convention).
function formatEnumLabel(value: string): string {
  return value
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// Duplicated from prospects-table.tsx (private lookups there) rather than
// imported across files - same small-client-safe-helper convention as
// `formatEnumLabel` above.
const SIGNAL_STRENGTH_BADGE_VARIANT: Record<SignalStrength, 'success' | 'warning' | 'destructive'> = {
  strong: 'success',
  medium: 'warning',
  weak: 'destructive',
};

const SIGNAL_STRENGTH_ICON: Record<SignalStrength, typeof CheckmarkCircle02Icon> = {
  strong: CheckmarkCircle02Icon,
  medium: Alert02Icon,
  weak: AlertCircleIcon,
};

const SIGNAL_STRENGTH_LABEL: Record<SignalStrength, string> = {
  strong: 'High',
  medium: 'Medium',
  weak: 'Low',
};

function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground text-right">{value}</span>
    </div>
  );
}

export interface SelectedSignal {
  signal: Signal;
  companyName: string;
  sourceUrl: string;
}

interface SignalDetailDialogProps {
  selected: SelectedSignal | null;
  onOpenChange: (open: boolean) => void;
}

export function SignalDetailDialog({ selected, onOpenChange }: SignalDetailDialogProps): React.JSX.Element {
  return (
    <Dialog open={selected !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {selected ? (
          <>
            <DialogHeader>
              <DialogTitle>{selected.companyName}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <DetailRow label="Type" value={formatEnumLabel(selected.signal.type)} />
              <DetailRow
                label="Strength"
                value={
                  <Badge variant={SIGNAL_STRENGTH_BADGE_VARIANT[selected.signal.strength]}>
                    <HugeiconsIcon
                      icon={SIGNAL_STRENGTH_ICON[selected.signal.strength]}
                      data-icon="inline-start"
                      strokeWidth={2}
                    />
                    {SIGNAL_STRENGTH_LABEL[selected.signal.strength]}
                  </Badge>
                }
              />

              <Separator />

              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-sm">Description</span>
                <p className="text-sm">{selected.signal.description}</p>
              </div>

              {selected.signal.evidence ? (
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-sm">Evidence</span>
                  <p className="text-sm">{selected.signal.evidence}</p>
                </div>
              ) : null}

              <DetailRow
                label="Source"
                value={
                  <a href={selected.sourceUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                    Link
                  </a>
                }
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
