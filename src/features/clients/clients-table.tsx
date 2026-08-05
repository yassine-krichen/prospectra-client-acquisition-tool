'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listClientsResponseSchema, type Client } from '@/features/clients/client.types';

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchClients()
      .then((result) => {
        if (cancelled) return;
        setClients(result);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load clients.');
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
          <Link href={`/clients/${row.original.id}`} className="underline">
            {row.original.companyName}
          </Link>
        ),
      },
      { accessorKey: 'domain', header: 'Domain', cell: ({ row }) => row.original.domain ?? '—' },
      { accessorKey: 'industry', header: 'Industry' },
      { accessorKey: 'companySize', header: 'Company size' },
      {
        id: 'doNotContact',
        header: 'Do-not-contact',
        cell: ({ row }) => (row.original.doNotContact ? 'Yes' : 'No'),
      },
      {
        id: 'jobCount',
        header: '# Jobs',
        cell: ({ row }) => row.original.jobs.length,
      },
    ],
    []
  );

  const table = useReactTable({ data: clients, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="flex flex-col gap-4 p-6">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

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
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : clients.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                No clients found.
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
  );
}
