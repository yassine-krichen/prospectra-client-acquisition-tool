'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  industrySchema,
  projectFitSchema,
  prospectListItemSchema,
  prospectSourceSchema,
  prospectStatusSchema,
  signalStrengthSchema,
  signalTypeSchema,
  type Industry,
  type ProjectFit,
  type ProspectListItem,
  type ProspectSource,
  type ProspectStatus,
  type SignalStrength,
  type SignalType,
} from '@/features/prospects/prospect.types';

// Mirrors `ProspectSortField` in `prospects.repository.ts`. Duplicated
// (rather than imported) because that module pulls in the Prisma client,
// which must not end up in the client bundle.
type SortField = 'priorityScore' | 'discoveredAt' | 'sentAt';

const listProspectsResponseSchema = z.object({
  prospects: z.array(prospectListItemSchema),
  nextCursor: z.string().nullable(),
});

// Sentinel used by the filter `Select`s in place of an empty string — Radix
// `Select.Item` requires a non-empty `value`.
const ALL = 'all';

interface FiltersState {
  source: ProspectSource | typeof ALL;
  signalType: SignalType | typeof ALL;
  signalStrength: SignalStrength | typeof ALL;
  industry: Industry | typeof ALL;
  projectFit: ProjectFit | typeof ALL;
  status: ProspectStatus | typeof ALL;
  priorityScoreMin: string;
  priorityScoreMax: string;
  hasVerifiedEmail: typeof ALL | 'true' | 'false';
}

const DEFAULT_FILTERS: FiltersState = {
  source: ALL,
  signalType: ALL,
  signalStrength: ALL,
  industry: ALL,
  projectFit: ALL,
  status: ALL,
  priorityScoreMin: '',
  priorityScoreMax: '',
  hasVerifiedEmail: ALL,
};

const DEFAULT_SORTING: SortingState = [{ id: 'discoveredAt', desc: true }];

const SORT_FIELDS: readonly SortField[] = ['priorityScore', 'discoveredAt', 'sentAt'];

function isSortField(id: string): id is SortField {
  return (SORT_FIELDS as readonly string[]).includes(id);
}

function buildQueryParams(filters: FiltersState, sorting: SortingState, cursor: string | undefined): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.source !== ALL) params.set('source', filters.source);
  if (filters.signalType !== ALL) params.set('signalType', filters.signalType);
  if (filters.signalStrength !== ALL) params.set('signalStrength', filters.signalStrength);
  if (filters.industry !== ALL) params.set('industry', filters.industry);
  if (filters.projectFit !== ALL) params.set('projectFit', filters.projectFit);
  if (filters.status !== ALL) params.set('status', filters.status);
  if (filters.priorityScoreMin.trim() !== '') params.set('priorityScoreMin', filters.priorityScoreMin);
  if (filters.priorityScoreMax.trim() !== '') params.set('priorityScoreMax', filters.priorityScoreMax);
  if (filters.hasVerifiedEmail !== ALL) params.set('hasVerifiedEmail', filters.hasVerifiedEmail);

  const sort = sorting[0];
  if (sort && isSortField(sort.id)) {
    params.set('sortField', sort.id);
    params.set('sortDirection', sort.desc ? 'desc' : 'asc');
  }

  if (cursor) params.set('cursor', cursor);

  return params;
}

async function fetchProspects(
  params: URLSearchParams
): Promise<{ prospects: ProspectListItem[]; nextCursor: string | null }> {
  const response = await fetch(`/api/prospects?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to load prospects (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return listProspectsResponseSchema.parse(body);
}

function formatDate(value: Date | null): string {
  return value ? value.toLocaleDateString() : '—';
}

export function ProspectsTable(): React.JSX.Element {
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS);
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING);
  // History of cursors used to reach the current page. Empty = first page.
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [prospects, setProspects] = useState<ProspectListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentCursor = cursorStack[cursorStack.length - 1];

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchProspects(buildQueryParams(filters, sorting, currentCursor))
      .then((result) => {
        if (cancelled) return;
        setProspects(result.prospects);
        setNextCursor(result.nextCursor);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load prospects.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filters, sorting, currentCursor]);

  function updateFilter<K extends keyof FiltersState>(key: K, value: FiltersState[K]): void {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setCursorStack([]);
  }

  function resetFilters(): void {
    setFilters(DEFAULT_FILTERS);
    setCursorStack([]);
  }

  function handleSortingChange(updater: SortingState | ((old: SortingState) => SortingState)): void {
    setSorting(updater);
    setCursorStack([]);
  }

  function goToNextPage(): void {
    if (!nextCursor) return;
    setCursorStack((prev) => [...prev, nextCursor]);
  }

  function goToPreviousPage(): void {
    setCursorStack((prev) => prev.slice(0, -1));
  }

  const columns = useMemo<ColumnDef<ProspectListItem>[]>(
    () => [
      { accessorKey: 'companyName', header: 'Company' },
      {
        accessorKey: 'domain',
        header: 'Domain',
        cell: ({ row }) => row.original.domain ?? '—',
      },
      { accessorKey: 'industry', header: 'Industry' },
      { accessorKey: 'source', header: 'Source' },
      {
        id: 'signal',
        header: 'Signal',
        cell: ({ row }) => `${row.original.signal.type} (${row.original.signal.strength})`,
      },
      { accessorKey: 'projectFit', header: 'Project fit' },
      {
        accessorKey: 'priorityScore',
        header: 'Priority',
        enableSorting: true,
      },
      { accessorKey: 'status', header: 'Status' },
      {
        accessorKey: 'discoveredAt',
        header: 'Discovered',
        enableSorting: true,
        cell: ({ row }) => formatDate(row.original.discoveredAt),
      },
      {
        accessorKey: 'sentAt',
        header: 'Sent',
        enableSorting: true,
        cell: ({ row }) => formatDate(row.original.sentAt),
      },
      {
        id: 'emailVerified',
        header: 'Email verified',
        cell: ({ row }) => (row.original.emailVerified ? 'Yes' : 'No'),
      },
    ],
    []
  );

  const table = useReactTable({
    data: prospects,
    columns,
    state: { sorting },
    onSortingChange: handleSortingChange,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    enableMultiSort: false,
  });

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          label="Source"
          value={filters.source}
          options={prospectSourceSchema.options}
          onChange={(value) => updateFilter('source', value as FiltersState['source'])}
        />
        <FilterSelect
          label="Signal type"
          value={filters.signalType}
          options={signalTypeSchema.options}
          onChange={(value) => updateFilter('signalType', value as FiltersState['signalType'])}
        />
        <FilterSelect
          label="Signal strength"
          value={filters.signalStrength}
          options={signalStrengthSchema.options}
          onChange={(value) => updateFilter('signalStrength', value as FiltersState['signalStrength'])}
        />
        <FilterSelect
          label="Industry"
          value={filters.industry}
          options={industrySchema.options}
          onChange={(value) => updateFilter('industry', value as FiltersState['industry'])}
        />
        <FilterSelect
          label="Project fit"
          value={filters.projectFit}
          options={projectFitSchema.options}
          onChange={(value) => updateFilter('projectFit', value as FiltersState['projectFit'])}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          options={prospectStatusSchema.options}
          onChange={(value) => updateFilter('status', value as FiltersState['status'])}
        />
        <FilterSelect
          label="Verified email"
          value={filters.hasVerifiedEmail}
          options={['true', 'false']}
          onChange={(value) => updateFilter('hasVerifiedEmail', value as FiltersState['hasVerifiedEmail'])}
        />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Priority min</label>
          <Input
            type="number"
            className="w-24"
            value={filters.priorityScoreMin}
            onChange={(event) => updateFilter('priorityScoreMin', event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Priority max</label>
          <Input
            type="number"
            className="w-24"
            value={filters.priorityScoreMax}
            onChange={(event) => updateFilter('priorityScoreMax', event.target.value)}
          />
        </div>
        <Button variant="outline" onClick={resetFilters}>
          Clear filters
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sortDirection = header.column.getIsSorted();

                return (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        className="flex items-center gap-1"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sortDirection === 'asc' ? '↑' : sortDirection === 'desc' ? '↓' : null}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                );
              })}
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
          ) : prospects.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                No prospects found.
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

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" disabled={cursorStack.length === 0 || isLoading} onClick={goToPreviousPage}>
          Previous
        </Button>
        <Button variant="outline" disabled={!nextCursor || isLoading} onClick={goToNextPage}>
          Next
        </Button>
      </div>
    </div>
  );
}

interface FilterSelectProps {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}

function FilterSelect({ label, value, options, onChange }: FilterSelectProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
