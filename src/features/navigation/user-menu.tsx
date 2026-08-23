'use client';

import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { HugeiconsIcon } from '@hugeicons/react';
import { Sun01Icon, Moon01Icon, ComputerIcon, Logout01Icon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface UserMenuProps {
  nickname: string | null;
}

// Trivially safe by design - same rule as dashboard-nav.tsx: no server-only
// imports, ever. Logout goes through a fetch to a route handler rather than
// touching the session cookie/verification logic directly from the client.
export function UserMenu({ nickname }: UserMenuProps): React.JSX.Element {
  const router = useRouter();
  const { setTheme } = useTheme();

  async function handleLogout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Logout request failed', error);
    }
    router.push('/login');
  }

  return (
    <div className="border-sidebar-border mt-1 flex items-center gap-1 border-t pt-3">
      <span className="text-sidebar-foreground/70 flex-1 truncate px-2 text-sm">Welcome, {nickname ?? 'guest'}</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-sidebar-foreground/70 hover:text-sidebar-accent-foreground size-8"
          >
            <HugeiconsIcon icon={Sun01Icon} strokeWidth={2} className="size-4 scale-100 dark:scale-0" />
            <HugeiconsIcon
              icon={Moon01Icon}
              strokeWidth={2}
              className="absolute size-4 scale-0 dark:scale-100"
            />
            <span className="sr-only">Toggle theme</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setTheme('light')}>
            <HugeiconsIcon icon={Sun01Icon} strokeWidth={2} />
            Light
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTheme('dark')}>
            <HugeiconsIcon icon={Moon01Icon} strokeWidth={2} />
            Dark
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTheme('system')}>
            <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
            System
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="icon"
        className="text-sidebar-foreground/70 hover:text-sidebar-accent-foreground size-8"
        onClick={handleLogout}
      >
        <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} className="size-4" />
        <span className="sr-only">Log out</span>
      </Button>
    </div>
  );
}
