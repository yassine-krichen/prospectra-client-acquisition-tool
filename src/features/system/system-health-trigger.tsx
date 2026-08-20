'use client';

import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Activity01Icon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { SystemHealthPanel } from '@/features/system/system-health-panel';
import type { SystemHealth } from '@/features/system/system-health.service';
import { deriveOverallStatus, type OverallStatus } from '@/features/system/derive-overall-status';

const STATUS_DOT_CLASS: Record<OverallStatus, string> = {
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-destructive',
  unknown: 'bg-muted-foreground/40',
};

/**
 * Sidebar footer entry point into the system-health panel: a small live
 * status dot (fetched on mount, not just on open, so a problem is visible
 * without having to click in) plus a dialog with the full breakdown.
 */
export function SystemHealthTrigger(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/system/health')
      .then((res) => (res.ok ? (res.json() as Promise<SystemHealth>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load system health.');
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const status = deriveOverallStatus(health);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        className="text-sidebar-foreground/70 hover:text-sidebar-accent-foreground w-full justify-start gap-3 px-3"
        onClick={() => setOpen(true)}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <HugeiconsIcon icon={Activity01Icon} strokeWidth={2} className="size-4 opacity-70" />
          <span className={`absolute -right-0.5 -top-0.5 size-2 rounded-full ${STATUS_DOT_CLASS[status]}`} />
        </span>
        System Health
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>System Health</DialogTitle>
          <DialogDescription>Quotas, storage, and pipeline status at a glance.</DialogDescription>
        </DialogHeader>
        <SystemHealthPanel health={health} error={error} />
      </DialogContent>
    </Dialog>
  );
}
