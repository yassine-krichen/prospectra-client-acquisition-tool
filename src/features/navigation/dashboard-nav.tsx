'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  Target01Icon,
  ClipboardListIcon,
  Building02Icon,
  Compass01Icon,
  Route01Icon,
} from '@hugeicons/core-free-icons';

import { SystemHealthTrigger } from '@/features/system/system-health-trigger';
import { UserMenu } from '@/features/navigation/user-menu';

// Trivially safe by design - no server-only imports, ever. Every dashboard
// page renders inside a layout that includes this component, so it must
// never risk pulling in `@/common/config/env`, `@/common/db/client`, or any
// `.service`/`.repository` module.
const NAV_ITEMS: ReadonlyArray<{ href: string; label: string; icon: IconSvgElement; description: string }> = [
  { href: '/prospects', label: 'Prospects', icon: Target01Icon, description: 'Discovered leads' },
  { href: '/queue', label: 'Queue', icon: ClipboardListIcon, description: 'Approve outreach' },
  { href: '/clients', label: 'Clients', icon: Building02Icon, description: 'Won accounts' },
  { href: '/discovery', label: 'Discovery', icon: Compass01Icon, description: 'Find new leads' },
  { href: '/pipeline', label: 'Pipeline', icon: Route01Icon, description: 'Batch operations' },
];

export function DashboardNav(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <nav className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-60 shrink-0 flex-col gap-1 border-r p-4">
      <div className="mb-4 px-2">
        <span className="text-base font-semibold tracking-tight">Biz Scraper</span>
      </div>

      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
            }`}
          >
            <HugeiconsIcon
              icon={item.icon}
              strokeWidth={2}
              className={`size-4 shrink-0 ${isActive ? '' : 'opacity-70 group-hover:opacity-100'}`}
            />
            <div className="flex flex-col">
              <span>{item.label}</span>
            </div>
          </Link>
        );
      })}

      <div className="mt-auto flex flex-col gap-1">
        <SystemHealthTrigger />
        <UserMenu />
      </div>
    </nav>
  );
}
