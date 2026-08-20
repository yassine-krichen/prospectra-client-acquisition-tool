'use client';

import type { Table } from '@tanstack/react-table';
import { HugeiconsIcon } from '@hugeicons/react';
import { Settings02Icon } from '@hugeicons/core-free-icons';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Ported from tablecn (https://github.com/sadmann7/tablecn), icon swapped
// from lucide-react to this project's existing icon library (hugeicons).

interface DataTableViewOptionsProps<TData> extends React.ComponentProps<typeof PopoverContent> {
  table: Table<TData>;
  disabled?: boolean;
}

export function DataTableViewOptions<TData>({
  table,
  disabled,
  className,
  ...props
}: DataTableViewOptionsProps<TData>): React.JSX.Element {
  const columns = React.useMemo(
    () => table.getAllColumns().filter((column) => typeof column.accessorFn !== 'undefined' && column.getCanHide()),
    [table]
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Toggle columns"
          role="combobox"
          variant="outline"
          size="sm"
          className="ml-auto hidden font-normal lg:flex"
          disabled={disabled}
        >
          <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} className="text-muted-foreground" />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn('w-44 p-0', className)} {...props}>
        <Command>
          <CommandInput placeholder="Search columns..." />
          <CommandList>
            <CommandEmpty>No columns found.</CommandEmpty>
            <CommandGroup>
              {columns.map((column) => (
                <CommandItem
                  key={column.id}
                  data-checked={column.getIsVisible()}
                  onSelect={() => column.toggleVisibility(!column.getIsVisible())}
                >
                  <span className="truncate">{column.columnDef.meta?.label ?? column.id}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
