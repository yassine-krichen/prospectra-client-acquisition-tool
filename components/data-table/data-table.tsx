import { flexRender, type Row, type Table as TanstackTable } from '@tanstack/react-table';
import type * as React from 'react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getColumnPinningStyle } from '@/lib/data-table';
import { cn } from '@/lib/utils';

// Ported from tablecn (https://github.com/sadmann7/tablecn) and adapted for
// this app's cursor-based server pagination - see data-table-pagination.tsx's
// header comment for what changed and why. `getRowClassName` is also an
// addition tablecn doesn't have: this app dims rows in a data-driven way
// (e.g. prospects-table.tsx already-seen rows) which tablecn's row-selection-
// only `data-state` styling has no hook for.

interface DataTableProps<TData> extends React.ComponentProps<'div'> {
  table: TanstackTable<TData>;
  pagination?: React.ReactNode;
  actionBar?: React.ReactNode;
  emptyState?: React.ReactNode;
  getRowClassName?: (row: Row<TData>) => string | undefined;
}

export function DataTable<TData>({
  table,
  pagination,
  actionBar,
  emptyState,
  getRowClassName,
  children,
  className,
  ...props
}: DataTableProps<TData>): React.JSX.Element {
  return (
    <div className={cn('flex w-full flex-col gap-2.5 overflow-auto', className)} {...props}>
      {children}
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} colSpan={header.colSpan} style={getColumnPinningStyle({ column: header.column })}>
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'} className={getRowClassName?.(row)}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} style={getColumnPinningStyle({ column: cell.column })}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={table.getAllColumns().length} className="h-24 text-center">
                  {emptyState ?? 'No results.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-col gap-2.5">
        {pagination}
        {actionBar && table.getFilteredSelectedRowModel().rows.length > 0 && actionBar}
      </div>
    </div>
  );
}
