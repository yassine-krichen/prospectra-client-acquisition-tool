import Link from 'next/link';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Target01Icon,
  ClipboardListIcon,
  Building02Icon,
  Compass01Icon,
  Route01Icon,
  ArrowRight01Icon,
} from '@hugeicons/core-free-icons';

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { getSystemHealth, type SystemHealth } from '@/features/system/system-health.service';

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

const QUICK_LINKS = [
  { href: '/prospects', label: 'Prospects', description: 'Review discovered leads', icon: Target01Icon },
  { href: '/queue', label: 'Queue', description: 'Approve outreach drafts', icon: ClipboardListIcon },
  { href: '/clients', label: 'Clients', description: 'Won accounts and Jobs', icon: Building02Icon },
  { href: '/discovery', label: 'Discovery', description: 'Find new leads', icon: Compass01Icon },
  { href: '/pipeline', label: 'Pipeline', description: 'Run batch operations', icon: Route01Icon },
] as const;

// Server component - calls the health service directly rather than fetching
// its own API route client-side, since this page has no interactive parts
// of its own (the ping button/live-refresh version of this data lives in
// the sidebar's System Health dialog, a client component). Lives at
// app/(dashboard)/page.tsx (not app/page.tsx) so the route group's sidebar
// layout wraps it like every other dashboard page - route groups don't
// affect the URL, this still serves "/".
export default async function Page(): Promise<React.JSX.Element> {
  const health = await getSystemHealth();
  const funnelTotal = Object.values(health.prospectFunnel).reduce((sum, count) => sum + count, 0);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <p className="text-muted-foreground text-sm">Cold-outreach pipeline: discover, enrich, draft, send, follow up.</p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Services configured</CardTitle>
          <CardDescription>
            {funnelTotal} prospect{funnelTotal === 1 ? '' : 's'} on file ·{' '}
            {health.database.reachable ? `${health.database.sizeMB ?? '?'} MB in the database` : 'database unreachable'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Progress value={health.configuredPercent} className="mr-4" />
            <span className="text-foreground shrink-0 text-2xl font-semibold tabular-nums">{health.configuredPercent}%</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(SERVICE_LABELS) as Array<keyof typeof SERVICE_LABELS>).map((key) => (
              <Badge key={key} variant={health.configuredServices[key] ? 'secondary' : 'outline'}>
                {SERVICE_LABELS[key]}
              </Badge>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            A service counts once its API key is set in <code>.env</code>, even if it later turns out to be broken
            (e.g. billing not enabled) - see System Health in the sidebar for storage, quotas, and send-cap detail.
          </p>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-medium">Jump to</h2>
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          {QUICK_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              <Card className="hover:ring-foreground/20 transition-shadow">
                <CardContent className="flex items-center gap-3">
                  <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
                    <HugeiconsIcon icon={link.icon} strokeWidth={2} className="size-4" />
                  </div>
                  <div className="flex flex-1 flex-col">
                    <span className="text-sm font-medium">{link.label}</span>
                    <span className="text-muted-foreground text-xs">{link.description}</span>
                  </div>
                  <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="text-muted-foreground size-4" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
