'use client';

import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Loading03Icon } from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import type { SystemHealth } from '@/features/system/system-health.service';
import type { DbPingResult } from '@/app/api/system/db-ping/route';
import { toastError } from '@/lib/toast';

interface SystemHealthPanelProps {
  health: SystemHealth | null;
  error: string | null;
}

const SERVICE_LABELS: Record<keyof SystemHealth['configuredServices'], string> = {
  googlePlaces: 'Google Places',
  builtwith: 'BuiltWith',
  companiesHouse: 'UK Companies House',
  texasComptroller: 'Texas Comptroller',
  productHunt: 'Product Hunt',
  crunchbase: 'Crunchbase',
  github: 'GitHub',
  hunter: 'Hunter.io',
  peopleDataLabs: 'People Data Labs',
  gemini: 'Gemini',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  claudeBridge: 'Claude Bridge',
  resend: 'Resend',
};

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  enriched: 'Enriched',
  drafted: 'Drafted',
  queued: 'Queued',
  sent: 'Sent',
  followup_1: 'Follow-up 1',
  followup_2: 'Follow-up 2',
  followup_3: 'Follow-up 3',
  replied: 'Replied',
  won: 'Won',
  dead: 'Dead',
  unsubscribed: 'Unsubscribed',
};

function QuotaBar({ label, used, cap }: { label: string; used: number; cap: number }): React.JSX.Element {
  const percent = cap > 0 ? Math.min((used / cap) * 100, 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground">
          {used} / {cap}
        </span>
      </div>
      <Progress value={percent} />
    </div>
  );
}

function NoData({ label }: { label?: string }): React.JSX.Element {
  return <span className="text-xs text-muted-foreground">{label ?? 'NO DATA'}</span>;
}

export function SystemHealthPanel({ health, error }: SystemHealthPanelProps): React.JSX.Element {
  const [ping, setPing] = useState<DbPingResult | null>(null);
  const [isPinging, setIsPinging] = useState(false);

  async function handlePing(): Promise<void> {
    setIsPinging(true);
    try {
      const response = await fetch('/api/system/db-ping');
      const result: DbPingResult = await response.json();
      setPing(result);
      if (!result.ok) toastError('Database ping failed', result.error ?? undefined);
    } catch {
      setPing({ ok: false, latencyMs: null, good: false, error: 'Request failed.' });
      toastError('Database ping failed', 'Request failed.');
    } finally {
      setIsPinging(false);
    }
  }

  if (error) {
    // The failure itself is toasted by the caller (system-health-trigger.tsx)
    // - this is just a neutral "nothing to show" fallback, not a second
    // error surface.
    return <p className="text-muted-foreground text-sm">{error}</p>;
  }

  if (!health) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  const funnelEntries = Object.entries(health.prospectFunnel).filter(([, count]) => count > 0);
  const funnelTotal = Object.values(health.prospectFunnel).reduce((sum, count) => sum + count, 0);

  return (
    <div className="flex max-h-[70vh] [scrollbar-width:none] flex-col gap-5 overflow-y-auto pr-1 [&::-webkit-scrollbar]:hidden">
      <div className="flex flex-col gap-1.5 rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">Services configured</span>
          <span className="text-lg font-semibold text-foreground tabular-nums">{health.configuredPercent}%</span>
        </div>
        <Progress value={health.configuredPercent} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">Database ping</span>
          <Button variant="outline" size="sm" onClick={() => void handlePing()} disabled={isPinging}>
            {isPinging ? <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-3.5 animate-spin" /> : null}
            {isPinging ? 'Pinging...' : 'Ping database'}
          </Button>
        </div>
        {ping ? (
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`size-2.5 shrink-0 rounded-full ${
                !ping.ok ? 'bg-destructive' : ping.good ? 'bg-emerald-500' : 'bg-destructive'
              }`}
              aria-hidden
            />
            {ping.ok ? (
              <span className="text-foreground">{ping.latencyMs}ms</span>
            ) : (
              <span className="text-muted-foreground">{ping.error ?? 'Ping failed.'}</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Not pinged yet this session.</span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-foreground">Neon storage</span>
          {health.neon.configured && health.neon.storagePercentUsed !== null ? (
            <span className="text-muted-foreground">
              {health.neon.storageUsedMB} MB / {health.neon.storageLimitMB} MB
            </span>
          ) : null}
        </div>
        {health.neon.configured && health.neon.storagePercentUsed !== null ? (
          <Progress value={health.neon.storagePercentUsed} />
        ) : health.neon.configured && health.neon.error ? (
          <NoData label={`NO DATA - ${health.neon.error}`} />
        ) : (
          <NoData label="NO DATA - set NEON_API_KEY and NEON_PROJECT_ID to enable" />
        )}
        {health.neon.configured && health.neon.computeSecondsUsed !== null ? (
          <span className="text-[0.7rem] text-muted-foreground">
            Compute used this period: {health.neon.computeSecondsUsed}s · Data transfer: {health.neon.dataTransferMB} MB
          </span>
        ) : null}
        <span className="text-[0.7rem] text-muted-foreground">
          Live connection check: {health.database.reachable ? `reachable, ${health.database.sizeMB ?? '?'} MB` : 'unreachable'}
        </span>
      </div>

      {health.hunter.configured && health.hunter.used !== null && health.hunter.available !== null ? (
        <div className="flex flex-col gap-1.5">
          <QuotaBar label="Hunter.io searches this month" used={health.hunter.used} cap={health.hunter.available} />
          <span className="text-[0.7rem] text-muted-foreground">
            Live from Hunter&apos;s own account ({health.hunter.planName ?? 'unknown plan'}), not a local count - resets{' '}
            {health.hunter.resetDate ?? 'unknown date'}.
          </span>
        </div>
      ) : health.hunter.configured && health.hunter.error ? (
        <div className="flex items-center justify-between text-xs">
          <span className="text-foreground">Hunter.io</span>
          <NoData label={`NO DATA - ${health.hunter.error}`} />
        </div>
      ) : (
        <div className="flex items-center justify-between text-xs">
          <span className="text-foreground">Hunter.io</span>
          <Badge variant="outline">Not configured</Badge>
        </div>
      )}

      <QuotaBar label="Sends used today" used={health.sending.sentToday} cap={health.sending.dailyCap} />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={health.sending.domainVerified ? 'default' : 'outline'}>
          {health.sending.domainVerified ? 'Domain verified' : 'DOMAIN NOT VERIFIED'}
        </Badge>
        {health.configuredServices.claudeBridge ? (
          <Badge variant={health.bridgeInCooldown ? 'destructive' : 'outline'}>
            {health.bridgeInCooldown ? 'Claude Bridge: rate-limited, in cooldown' : 'Claude Bridge: ready'}
          </Badge>
        ) : null}
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-foreground">Configured services</span>
        <ul className="flex flex-col gap-1">
          {(Object.keys(SERVICE_LABELS) as Array<keyof typeof SERVICE_LABELS>).map((key) => {
            const configured = health.configuredServices[key];
            return (
              <li key={key} className="flex items-center gap-2 text-xs">
                <span className={`shrink-0 ${configured ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground'}`}>
                  •
                </span>
                <span className="flex-1 text-foreground">{SERVICE_LABELS[key]}</span>
                <span className={configured ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground'}>
                  {configured ? 'Configured' : 'Not configured'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-foreground">Prospect funnel ({funnelTotal} total)</span>
        {funnelEntries.length === 0 ? (
          <span className="text-xs text-muted-foreground">No prospects discovered yet.</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {funnelEntries.map(([status, count]) => (
              <div key={status} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{STATUS_LABELS[status] ?? status}</span>
                <span className="font-medium text-foreground">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
