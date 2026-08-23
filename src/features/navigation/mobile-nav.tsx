'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import { Menu01Icon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { DashboardNav } from '@/features/navigation/dashboard-nav';

interface MobileNavProps {
  nickname: string | null;
}

// Slim top bar shown only below the `lg` breakpoint (see app/(dashboard)/layout.tsx,
// which renders `DashboardNav` directly - `hidden lg:flex` - alongside this).
// Reuses `DashboardNav` verbatim inside the sheet rather than forking its
// `NAV_ITEMS`/rendering logic, so the two never drift out of sync.
export function MobileNav({ nickname }: MobileNavProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Tracks the pathname `open` was last computed for, so a change can be
  // detected and reacted to during render (the React-recommended "adjust
  // state when a prop changes" pattern - see the identical
  // `enabledSourcesComputedFor` precedent in discovery-trigger-form.tsx)
  // rather than a `useEffect` calling `setState` synchronously, which
  // triggers an extra cascading render.
  const [openComputedForPathname, setOpenComputedForPathname] = useState(pathname);

  // Close the drawer automatically whenever navigation actually happens, so
  // tapping a nav link doesn't leave the sheet open over the new page.
  if (openComputedForPathname !== pathname) {
    setOpenComputedForPathname(pathname);
    setOpen(false);
  }

  return (
    <div className="bg-sidebar text-sidebar-foreground border-sidebar-border flex items-center gap-3 border-b p-3 lg:hidden">
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open navigation menu">
        <HugeiconsIcon icon={Menu01Icon} strokeWidth={2} />
      </Button>
      <span className="text-base font-semibold tracking-tight">Biz Scraper</span>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-60 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <DashboardNav nickname={nickname} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
