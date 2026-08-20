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

interface SystemHealthPanelProps {
  health: SystemHealth | null;
  error: string | null;
}

const SERVICE_LABELS: Record<keyof SystemHealth['configuredServices'], string> = {
  googlePlaces: 'Google Places',
  builtwith: 'BuiltWith',
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

const GOOD_PING_MS = 100;

export function SystemHealthPanel({ health, error }: SystemHealthPanelProps): React.JSX.Element {
  const [ping, setPing] = useState<DbPingResult | null>(null);
  const [isPinging, setIsPinging] = useState(false);

  async function handlePing(): Promise<void> {
    setIsPinging(true);
    try {
      const response = await fetch('/api/system/db-ping');
      const result: DbPingResult = await response.json();
      setPing(result);
    } catch {
      setPing({ ok: false, latencyMs: null, good: false, error: 'Request failed.' });
    } finally {
      setIsPinging(false);
    }
  }

  if (error) {
    return <p className="text-destructive text-sm">{error}</p>;
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
    <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-foreground text-xs font-medium">Database ping</span>
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
              <span className="text-destructive">{ping.error ?? 'Ping failed.'}</span>
            )}
            <span className="text-muted-foreground">(good is under {GOOD_PING_MS}ms)</span>
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">Not pinged yet this session.</span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-foreground">Database storage</span>
          <span className="text-muted-foreground">
            {health.database.reachable
              ? `${health.database.sizeMB ?? '?'} MB / ${health.database.limitMB} MB`
              : 'unreachable'}
          </span>
        </div>
        {health.database.reachable ? (
          <Progress value={health.database.percentUsed ?? 0} />
        ) : (
          <Badge variant="destructive">Database unreachable</Badge>
        )}
        {health.database.reachable && (
          <span className="text-muted-foreground text-[0.7rem]">
            Estimated against Neon&apos;s free-tier limit - not a live quota from Neon itself.
          </span>
        )}
      </div>

      {health.hunter.configured && health.hunter.cap !== null ? (
        <QuotaBar label="Hunter.io searches this month" used={health.hunter.used} cap={health.hunter.cap} />
      ) : (
        <div className="flex items-center justify-between text-xs">
          <span className="text-foreground">Hunter.io</span>
          <Badge variant="outline">Not configured</Badge>
        </div>
      )}

      <QuotaBar label="Sends used today" used={health.sending.sentToday} cap={health.sending.dailyCap} />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={health.sending.domainVerified ? 'default' : 'outline'}>
          {health.sending.domainVerified ? 'Domain verified' : 'Domain not verified (test cap applies)'}
        </Badge>
        <Badge variant={health.bridgeInCooldown ? 'destructive' : 'outline'}>
          Claude bridge {health.bridgeInCooldown ? 'in cooldown' : 'available'}
        </Badge>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <span className="text-foreground text-xs font-medium">Configured services</span>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(SERVICE_LABELS) as Array<keyof typeof SERVICE_LABELS>).map((key) => (
            <Badge key={key} variant={health.configuredServices[key] ? 'secondary' : 'outline'} className="opacity-90">
              {SERVICE_LABELS[key]}
            </Badge>
          ))}
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <span className="text-foreground text-xs font-medium">Prospect funnel ({funnelTotal} total)</span>
        {funnelEntries.length === 0 ? (
          <span className="text-muted-foreground text-xs">No prospects discovered yet.</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {funnelEntries.map(([status, count]) => (
              <div key={status} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{STATUS_LABELS[status] ?? status}</span>
                <span className="text-foreground font-medium">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
