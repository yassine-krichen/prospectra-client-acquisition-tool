'use client';

import type { Column } from '@tanstack/react-table';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, ArrowUp01Icon, ArrowUpDownIcon, ViewOffIcon, Cancel01Icon } from '@hugeicons/core-free-icons';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// Ported from tablecn (https://github.com/sadmann7/tablecn), icons swapped
// from lucide-react to this project's existing icon library (hugeicons, see
// components.json) rather than adding a second icon package.

interface DataTableColumnHeaderProps<TData, TValue> extends React.ComponentProps<typeof DropdownMenuTrigger> {
  column: Column<TData, TValue>;
  label: string;
}

export function DataTableColumnHeader<TData, TValue>({
  column,
  label,
  className,
  ...props
}: DataTableColumnHeaderProps<TData, TValue>): React.JSX.Element {
  if (!column.getCanSort() && !column.getCanHide()) {
    return <div className={cn(className)}>{label}</div>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'hover:bg-accent focus:ring-ring data-[state=open]:bg-accent -ml-1.5 flex h-8 items-center gap-1.5 rounded-md px-2 py-1.5 focus:ring-1 focus:outline-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
          className
        )}
        {...props}
      >
        {label}
        {column.getCanSort() &&
          (column.getIsSorted() === 'desc' ? (
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
          ) : column.getIsSorted() === 'asc' ? (
            <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
          ) : (
            <HugeiconsIcon icon={ArrowUpDownIcon} strokeWidth={2} />
          ))}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-28">
        {column.getCanSort() && (
          <>
            <DropdownMenuCheckboxItem
              className="relative pr-8 pl-2 [&>span:first-child]:right-2 [&>span:first-child]:left-auto [&_svg]:text-muted-foreground"
              checked={column.getIsSorted() === 'asc'}
              onClick={() => column.toggleSorting(false)}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} className="size-4" />
              Asc
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              className="relative pr-8 pl-2 [&>span:first-child]:right-2 [&>span:first-child]:left-auto [&_svg]:text-muted-foreground"
              checked={column.getIsSorted() === 'desc'}
              onClick={() => column.toggleSorting(true)}
            >
              <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-4" />
              Desc
            </DropdownMenuCheckboxItem>
            {column.getIsSorted() && (
              <DropdownMenuItem className="pl-2 [&_svg]:text-muted-foreground" onClick={() => column.clearSorting()}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                Reset
              </DropdownMenuItem>
            )}
          </>
        )}
        {column.getCanHide() && (
          <DropdownMenuCheckboxItem
            className="relative pr-8 pl-2 [&>span:first-child]:right-2 [&>span:first-child]:left-auto [&_svg]:text-muted-foreground"
            checked={!column.getIsVisible()}
            onClick={() => column.toggleVisibility(false)}
          >
            <HugeiconsIcon icon={ViewOffIcon} strokeWidth={2} className="size-4" />
            Hide
          </DropdownMenuCheckboxItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
