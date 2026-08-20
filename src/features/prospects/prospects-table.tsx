'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { type ColumnDef, type SortingState, type VisibilityState, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { z } from 'zod';
import { HugeiconsIcon } from '@hugeicons/react';
import { Compass01Icon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, type badgeVariants } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { DataTableViewOptions } from '@/components/data-table/data-table-view-options';
import { DataTableSkeleton } from '@/components/data-table/data-table-skeleton';
import { DataTableCursorPagination } from '@/components/data-table/data-table-pagination';
import { toastError, toastInfo, toastSourceResults, toastSuccess } from '@/lib/toast';
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
import {
  draftProspect,
  enrichProspect,
  matchProspect,
  setProspectSeen,
  winProspect,
} from '@/features/prospects/prospect-actions';
import type { VariantProps } from 'class-variance-authority';

type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];

// Mirrors `ProspectSortField` in `prospects.repository.ts`. Duplicated
// (rather than imported) because that module pulls in the Prisma client,
// which must not end up in the client bundle.
type SortField = 'priorityScore' | 'discoveredAt' | 'sentAt';

const listProspectsResponseSchema = z.object({
  prospects: z.array(prospectListItemSchema),
  nextCursor: z.string().nullable(),
});

// Sentinel used by the filter `Select`s in place of an empty string - Radix
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
  // Client-side-only convenience filter - translates to `seen=false` on the
  // wire (see buildQueryParams). Kept alongside the server-backed filters
  // above rather than as separate component state so `resetFilters`/the
  // cursor-reset-on-change behavior cover it for free.
  hideSeen: boolean;
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
  hideSeen: false,
};

const DEFAULT_SORTING: SortingState = [{ id: 'discoveredAt', desc: true }];

const SORT_FIELDS: readonly SortField[] = ['priorityScore', 'discoveredAt', 'sentAt'];

function isSortField(id: string): id is SortField {
  return (SORT_FIELDS as readonly string[]).includes(id);
}

const DEFAULT_LIMIT = 25;

function buildQueryParams(
  filters: FiltersState,
  sorting: SortingState,
  cursor: string | undefined,
  limit: number
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('limit', String(limit));

  if (filters.source !== ALL) params.set('source', filters.source);
  if (filters.signalType !== ALL) params.set('signalType', filters.signalType);
  if (filters.signalStrength !== ALL) params.set('signalStrength', filters.signalStrength);
  if (filters.industry !== ALL) params.set('industry', filters.industry);
  if (filters.projectFit !== ALL) params.set('projectFit', filters.projectFit);
  if (filters.status !== ALL) params.set('status', filters.status);
  if (filters.priorityScoreMin.trim() !== '') params.set('priorityScoreMin', filters.priorityScoreMin);
  if (filters.priorityScoreMax.trim() !== '') params.set('priorityScoreMax', filters.priorityScoreMax);
  if (filters.hasVerifiedEmail !== ALL) params.set('hasVerifiedEmail', filters.hasVerifiedEmail);
  if (filters.hideSeen) params.set('seen', 'false');

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
  return value ? value.toLocaleDateString() : '-';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}

function isDefaultFilters(filters: FiltersState): boolean {
  return (Object.keys(DEFAULT_FILTERS) as Array<keyof FiltersState>).every((key) => filters[key] === DEFAULT_FILTERS[key]);
}

const STATUS_BADGE_VARIANT: Record<ProspectStatus, BadgeVariant> = {
  new: 'outline',
  enriched: 'secondary',
  drafted: 'secondary',
  queued: 'secondary',
  sent: 'secondary',
  followup_1: 'secondary',
  followup_2: 'secondary',
  followup_3: 'secondary',
  replied: 'default',
  won: 'default',
  dead: 'outline',
  unsubscribed: 'outline',
};

const SIGNAL_BADGE_VARIANT: Record<SignalStrength, BadgeVariant> = {
  weak: 'outline',
  medium: 'secondary',
  strong: 'default',
};

export function ProspectsTable(): React.JSX.Element {
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS);
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  // History of cursors used to reach the current page. Empty = first page.
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [prospects, setProspects] = useState<ProspectListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-row action state: which prospects have an action in flight. Outcome
  // messaging itself goes through toasts (lib/toast.ts) now - the one bit of
  // state still tracked per row is a successful Win's clientId, since that
  // produces a persistent "view client" link a toast can't hold onto.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [wonClientIds, setWonClientIds] = useState<Record<string, string>>({});
  // Bumped after any action succeeds to re-trigger the load effect below, so
  // status/priorityScore/sentAt reflect the change from the server.
  const [refreshIndex, setRefreshIndex] = useState(0);

  const currentCursor = cursorStack[cursorStack.length - 1];

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchProspects(buildQueryParams(filters, sorting, currentCursor, limit))
      .then((result) => {
        if (cancelled) return;
        setProspects(result.prospects);
        setNextCursor(result.nextCursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filters, sorting, currentCursor, limit, refreshIndex]);

  const runAction = useCallback(async (prospectId: string, action: () => Promise<void>): Promise<void> => {
    setPendingIds((prev) => new Set(prev).add(prospectId));
    try {
      await action();
      setRefreshIndex((prev) => prev + 1);
    } catch (err) {
      toastError('Action failed', errorMessage(err));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(prospectId);
        return next;
      });
    }
  }, []);

  const handleEnrich = useCallback(
    (prospectId: string): void => {
      void runAction(prospectId, async () => {
        const result = await enrichProspect(prospectId);
        toastSourceResults('Enrichment', result.sources);
        if (result.downgradeSkipped) {
          toastInfo(
            'Kept existing contact',
            `${result.downgradeSkipped.reason} (existing confidence ${result.downgradeSkipped.existingConfidence}, attempted ${result.downgradeSkipped.attemptedConfidence})`
          );
        }
      });
    },
    [runAction]
  );

  const handleDraft = useCallback(
    (prospectId: string): void => {
      void runAction(prospectId, async () => {
        const result = await draftProspect(prospectId);
        if (result.ok) {
          const variantLabel = `${result.drafts.length} variant${result.drafts.length === 1 ? '' : 's'}`;
          const humanizeNote = result.humanize.attempted
            ? `Humanizer: ${result.humanize.outcome ?? 'attempted'}${result.humanize.reason ? `, ${result.humanize.reason}` : ''}`
            : undefined;
          toastSuccess(`Drafted ${variantLabel}`, humanizeNote);
        } else {
          toastError(`Draft flagged: ${result.flagged.replace(/_/g, ' ')}`, result.message);
        }
      });
    },
    [runAction]
  );

  const handleMatch = useCallback(
    (prospectId: string): void => {
      void runAction(prospectId, async () => {
        const result = await matchProspect(prospectId);
        if (result.outcome === 'applied') {
          const count = result.suggestedServices.length;
          toastSuccess(`Matched ${count} suggestion${count === 1 ? '' : 's'}`);
        } else {
          toastError('Invalid signal', result.reason);
        }
      });
    },
    [runAction]
  );

  const handleWin = useCallback(
    (prospectId: string): void => {
      void runAction(prospectId, async () => {
        const result = await winProspect(prospectId);
        switch (result.outcome) {
          case 'converted':
            setWonClientIds((prev) => ({ ...prev, [prospectId]: result.clientId }));
            toastSuccess('Converted to client');
            break;
          case 'already_converted':
            setWonClientIds((prev) => ({ ...prev, [prospectId]: result.clientId }));
            toastInfo('Already converted to a client');
            break;
          case 'blocked_do_not_contact':
            toastError('Cannot convert', 'This prospect is marked do-not-contact.');
            break;
          case 'not_found':
            toastError('Prospect not found', 'It may have been removed since this page loaded.');
            break;
        }
      });
    },
    [runAction]
  );

  const handleToggleSeen = useCallback((prospectId: string, seen: boolean): void => {
    // Optimistic, silent, no refetch: this is a read marker for the user's
    // own benefit, not pipeline state, so it shouldn't feel like an "action"
    // (no toast, no loading state on the row's other buttons).
    setProspects((prev) => prev.map((p) => (p.id === prospectId ? { ...p, seen } : p)));
    setProspectSeen(prospectId, seen).catch(() => {
      setProspects((prev) => prev.map((p) => (p.id === prospectId ? { ...p, seen: !seen } : p)));
    });
  }, []);

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

  function handlePageSizeChange(nextLimit: number): void {
    setLimit(nextLimit);
    setCursorStack([]);
  }

  const columns = useMemo<ColumnDef<ProspectListItem>[]>(
    () => [
      {
        id: 'seen',
        header: 'Seen',
        enableHiding: false,
        cell: ({ row }) => (
          <Checkbox
            checked={row.original.seen}
            onCheckedChange={(checked) => handleToggleSeen(row.original.id, checked === true)}
            aria-label={row.original.seen ? 'Mark as unseen' : 'Mark as seen'}
          />
        ),
      },
      {
        accessorKey: 'companyName',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Company" />,
        meta: { label: 'Company' },
      },
      {
        accessorKey: 'domain',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Domain" />,
        meta: { label: 'Domain' },
        cell: ({ row }) => row.original.domain ?? 'None',
      },
      {
        accessorKey: 'industry',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Industry" />,
        meta: { label: 'Industry' },
      },
      {
        accessorKey: 'source',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Source" />,
        meta: { label: 'Source' },
      },
      {
        id: 'signal',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Signal" />,
        meta: { label: 'Signal' },
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            <Badge variant={SIGNAL_BADGE_VARIANT[row.original.signal.strength]}>{row.original.signal.strength}</Badge>
            <span className="text-muted-foreground text-xs">{row.original.signal.type}</span>
          </div>
        ),
      },
      {
        accessorKey: 'projectFit',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Project fit" />,
        meta: { label: 'Project fit' },
      },
      {
        accessorKey: 'priorityScore',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Priority" />,
        meta: { label: 'Priority' },
        enableSorting: true,
      },
      {
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Status" />,
        meta: { label: 'Status' },
        cell: ({ row }) => <Badge variant={STATUS_BADGE_VARIANT[row.original.status]}>{row.original.status}</Badge>,
      },
      {
        accessorKey: 'discoveredAt',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Discovered" />,
        meta: { label: 'Discovered' },
        enableSorting: true,
        cell: ({ row }) => formatDate(row.original.discoveredAt),
      },
      {
        accessorKey: 'sentAt',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Sent" />,
        meta: { label: 'Sent' },
        enableSorting: true,
        cell: ({ row }) => formatDate(row.original.sentAt),
      },
      {
        id: 'emailVerified',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Email verified" />,
        meta: { label: 'Email verified' },
        cell: ({ row }) => (
          <Badge variant={row.original.emailVerified ? 'default' : 'outline'}>
            {row.original.emailVerified ? 'Yes' : 'No'}
          </Badge>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        enableHiding: false,
        cell: ({ row }) => {
          const prospectId = row.original.id;
          const isPending = pendingIds.has(prospectId);
          const clientId = wonClientIds[prospectId];

          return (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleEnrich(prospectId)}>
                  Enrich
                </Button>
                <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleDraft(prospectId)}>
                  Draft
                </Button>
                <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleMatch(prospectId)}>
                  Match
                </Button>
                <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleWin(prospectId)}>
                  Win
                </Button>
              </div>
              {clientId ? (
                <Link href={`/clients/${clientId}`} className="text-primary text-xs underline">
                  View client
                </Link>
              ) : null}
            </div>
          );
        },
      },
    ],
    [pendingIds, wonClientIds, handleToggleSeen, handleEnrich, handleDraft, handleMatch, handleWin]
  );

  const table = useReactTable({
    data: prospects,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: handleSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    enableMultiSort: false,
  });

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Prospects</h1>
        <p className="text-muted-foreground text-sm">Every lead discovery has found, ready to enrich, draft, and send.</p>
      </div>

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
          <label className="text-muted-foreground text-xs">Priority min</label>
          <Input
            type="number"
            className="w-24"
            value={filters.priorityScoreMin}
            onChange={(event) => updateFilter('priorityScoreMin', event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-muted-foreground text-xs">Priority max</label>
          <Input
            type="number"
            className="w-24"
            value={filters.priorityScoreMax}
            onChange={(event) => updateFilter('priorityScoreMax', event.target.value)}
          />
        </div>
        <label className="flex h-8 items-center gap-2 text-sm">
          <Checkbox checked={filters.hideSeen} onCheckedChange={(checked) => updateFilter('hideSeen', checked === true)} />
          Hide seen
        </label>
        <Button variant="outline" onClick={resetFilters}>
          Clear filters
        </Button>
        <DataTableViewOptions table={table} />
      </div>

      {error ? <p className="text-destructive text-sm">Couldn&apos;t load prospects: {error}</p> : null}

      {isLoading ? (
        <DataTableSkeleton columnCount={columns.length} rowCount={6} withViewOptions={false} />
      ) : (
        <DataTable
          table={table}
          getRowClassName={(row) => (row.original.seen ? 'opacity-50' : undefined)}
          pagination={
            <DataTableCursorPagination
              pageNumber={cursorStack.length + 1}
              canGoPrevious={cursorStack.length > 0}
              canGoNext={Boolean(nextCursor)}
              onPrevious={goToPreviousPage}
              onNext={goToNextPage}
              pageSize={limit}
              onPageSizeChange={handlePageSizeChange}
              rowCount={prospects.length}
            />
          }
          emptyState={
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <HugeiconsIcon icon={Compass01Icon} strokeWidth={1.5} className="text-muted-foreground size-8" />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">No prospects found</p>
                <p className="text-muted-foreground text-sm">
                  {isDefaultFilters(filters) ? 'Nothing discovered yet.' : 'No prospects match the current filters - try clearing them.'}
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href="/discovery">Run Discovery</Link>
              </Button>
            </div>
          }
        />
      )}
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
      <label className="text-muted-foreground text-xs">{label}</label>
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
