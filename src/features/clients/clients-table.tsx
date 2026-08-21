'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { HugeiconsIcon } from '@hugeicons/react';
import { Building02Icon } from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listClientsResponseSchema, type Client } from '@/features/clients/client.types';
import { toastError } from '@/lib/toast';

async function fetchClients(): Promise<Client[]> {
  const response = await fetch('/api/clients');
  if (!response.ok) {
    throw new Error(`Failed to load clients (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return listClientsResponseSchema.parse(body).clients;
}

export function ClientsTable(): React.JSX.Element {
  const [clients, setClients] = useState<Client[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    fetchClients()
      .then((result) => {
        if (cancelled) return;
        setClients(result);
      })
      .catch(() => {
        if (!cancelled) toastError('Failed to load clients.', 'Check your connection and try refreshing.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const columns = useMemo<ColumnDef<Client>[]>(
    () => [
      {
        id: 'companyName',
        header: 'Company name',
        cell: ({ row }) => (
          <Link href={`/clients/${row.original.id}`} className="text-foreground font-medium hover:underline">
            {row.original.companyName}
          </Link>
        ),
      },
      {
        accessorKey: 'domain',
        header: 'Domain',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.domain ?? '-'}</span>,
      },
      {
        accessorKey: 'industry',
        header: 'Industry',
        cell: ({ row }) => (
          <Badge variant="outline" className="capitalize">
            {row.original.industry.replace(/_/g, ' ')}
          </Badge>
        ),
      },
      {
        accessorKey: 'companySize',
        header: 'Company size',
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.companySize}</span>,
      },
      {
        id: 'doNotContact',
        header: 'Status',
        cell: ({ row }) =>
          row.original.doNotContact ? (
            <Badge variant="destructive">Do not contact</Badge>
          ) : (
            <span className="text-muted-foreground text-xs">Active</span>
          ),
      },
      {
        id: 'jobCount',
        header: 'Jobs',
        cell: ({ row }) => <Badge variant="secondary">{row.original.jobs.length}</Badge>,
      },
    ],
    []
  );

  const table = useReactTable({ data: clients, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Clients</h1>
        <p className="text-muted-foreground text-sm">Won prospects and their sold Jobs.</p>
      </div>

      <div className="bg-card overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <TableRow key={index}>
                  {columns.map((_, columnIndex) => (
                    <TableCell key={columnIndex}>
                      <Skeleton className="h-4 w-full max-w-32" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : clients.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <div className="bg-muted flex size-10 items-center justify-center rounded-full">
                      <HugeiconsIcon icon={Building02Icon} strokeWidth={2} className="text-muted-foreground size-5" />
                    </div>
                    <div>
                      <p className="text-foreground text-sm font-medium">No clients yet</p>
                      <p className="text-muted-foreground text-sm">
                        Clients are created by winning a prospect on the Prospects page.
                      </p>
                    </div>
                    <Button asChild size="sm" variant="outline">
                      <Link href="/prospects">Go to Prospects</Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
