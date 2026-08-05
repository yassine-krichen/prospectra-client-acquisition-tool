'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Trivially safe by design — no server-only imports, ever. Every dashboard
// page renders inside a layout that includes this component, so it must
// never risk pulling in `@/common/config/env`, `@/common/db/client`, or any
// `.service`/`.repository` module.
const NAV_ITEMS = [
  { href: '/prospects', label: 'Prospects' },
  { href: '/queue', label: 'Queue' },
  { href: '/clients', label: 'Clients' },
  { href: '/discovery', label: 'Discovery' },
  { href: '/pipeline', label: 'Pipeline' },
] as const;

export function DashboardNav(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-border p-4">
      <span className="mb-2 text-sm font-semibold">Backstop</span>
      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-2 text-sm ${
              isActive ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
