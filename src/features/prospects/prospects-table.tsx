'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { type ColumnDef, type SortingState, type VisibilityState, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { z } from 'zod';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Compass01Icon,
  DotIcon,
  EyeIcon,
  EyeOffIcon,
} from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { DataTableViewOptions } from '@/components/data-table/data-table-view-options';
import { DataTableSkeleton } from '@/components/data-table/data-table-skeleton';
import { DataTableCursorPagination } from '@/components/data-table/data-table-pagination';
import { ProspectDetailDialog } from '@/features/prospects/prospect-detail-dialog';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';
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
  bulkDeleteProspects,
  bulkDraftProspects,
  bulkEnrichProspects,
  bulkMatchProspects,
  bulkSetProspectsSeen,
  bulkWinProspects,
  setProspectSeen,
  type BulkActionResult,
} from '@/features/prospects/prospect-actions';

// Mirrors `ProspectSortField` in `prospects.repository.ts`. Duplicated
// (rather than imported) because that module pulls in the Prisma client,
// which must not end up in the client bundle.
type SortField = 'priorityScore' | 'discoveredAt' | 'sentAt';

const SORT_FIELD_LABELS: Record<SortField, string> = {
  priorityScore: 'Priority',
  discoveredAt: 'Discovered',
  sentAt: 'Sent',
};

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
  // Free-text substring match against the signal's description (the
  // "Reason" half of the Signal : Reason column) - not an enum like
  // signalType/signalStrength, so a plain string rather than ALL-sentinel'd.
  reason: string;
  industry: Industry | typeof ALL;
  projectFit: ProjectFit | typeof ALL;
  status: ProspectStatus | typeof ALL;
  priorityScoreMin: string;
  priorityScoreMax: string;
  hasVerifiedEmail: typeof ALL | 'true' | 'false';
  hasDraftFailure: typeof ALL | 'true' | 'false';
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
  reason: '',
  industry: ALL,
  projectFit: ALL,
  status: ALL,
  priorityScoreMin: '',
  priorityScoreMax: '',
  hasVerifiedEmail: ALL,
  hasDraftFailure: ALL,
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
  if (filters.reason.trim() !== '') params.set('reason', filters.reason.trim());
  if (filters.industry !== ALL) params.set('industry', filters.industry);
  if (filters.projectFit !== ALL) params.set('projectFit', filters.projectFit);
  if (filters.status !== ALL) params.set('status', filters.status);
  if (filters.priorityScoreMin.trim() !== '') params.set('priorityScoreMin', filters.priorityScoreMin);
  if (filters.priorityScoreMax.trim() !== '') params.set('priorityScoreMax', filters.priorityScoreMax);
  if (filters.hasVerifiedEmail !== ALL) params.set('hasVerifiedEmail', filters.hasVerifiedEmail);
  if (filters.hasDraftFailure !== ALL) params.set('hasDraftFailure', filters.hasDraftFailure);
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
  return value ? value.toLocaleDateString() : 'No Record';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}

// Bulk endpoints return a per-id { id, ok, reason? } result rather than an
// all-or-nothing outcome (see app/api/prospects/bulk/*/route.ts) - this
// turns that array into one toast reporting how many succeeded/failed,
// naming companies (not raw ids) wherever the id is still in the currently
// loaded page.
function toastBulkResults(actionLabel: string, results: BulkActionResult[], prospects: ProspectListItem[]): void {
  const nameFor = (id: string): string => prospects.find((p) => p.id === id)?.companyName ?? id;

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  const title =
    failed === 0
      ? `${actionLabel}: ${succeeded} succeeded`
      : `${actionLabel}: ${succeeded} succeeded, ${failed} failed`;
  const description =
    results
      .filter((r) => !r.ok)
      .map((r) => `${nameFor(r.id)}: ${r.reason ?? 'failed'}`)
      .join('\n') || undefined;

  if (failed === 0 && succeeded > 0) toastSuccess(title, description);
  else if (succeeded === 0) toastError(title, description);
  else toastInfo(title, description);
}

function isDefaultFilters(filters: FiltersState): boolean {
  return (Object.keys(DEFAULT_FILTERS) as Array<keyof FiltersState>).every((key) => filters[key] === DEFAULT_FILTERS[key]);
}

// Turns a snake_case enum value into readable English - "landing_page"
// becomes "Landing page" (only the first word capitalized, matching normal
// sentence casing rather than each-word Title Case).
function formatEnumLabel(value: string): string {
  return value
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

const SIGNAL_STRENGTH_BADGE_VARIANT: Record<SignalStrength, 'success' | 'warning' | 'destructive'> = {
  strong: 'success',
  medium: 'warning',
  weak: 'destructive',
};

const SIGNAL_STRENGTH_ICON: Record<SignalStrength, typeof CheckmarkCircle02Icon> = {
  strong: CheckmarkCircle02Icon,
  medium: Alert02Icon,
  weak: AlertCircleIcon,
};

const SIGNAL_STRENGTH_LABEL: Record<SignalStrength, string> = {
  strong: 'High',
  medium: 'Medium',
  weak: 'Low',
};

// Domains that are almost always a personal/student/hobby project rather
// than a real business (free static-hosting subdomains, .edu) - the list
// view has no way to open the site and judge it manually, so this is a
// best-effort filter to steer obvious non-clients toward "Ignore" rather
// than spending an enrich/draft credit on them.
const LOW_VALUE_DOMAIN_PATTERNS: readonly RegExp[] = [
  /\.edu$/i,
  /vercel\.app$/i,
  /netlify\.app$/i,
  /github\.io$/i,
  /pages\.dev$/i,
  /web\.app$/i,
  /herokuapp\.com$/i,
  /repl\.co$/i,
  /glitch\.me$/i,
  /wixsite\.com$/i,
  /weebly\.com$/i,
];

function isLikelyLowValue(prospect: ProspectListItem): boolean {
  return Boolean(prospect.domain) && LOW_VALUE_DOMAIN_PATTERNS.some((pattern) => pattern.test(prospect.domain!));
}

type RecommendationTone = 'green' | 'red' | 'neutral';

interface Recommendation {
  label: string;
  tone: RecommendationTone;
}

// Maps pipeline status to the next manual step a human would take on this
// prospect. `neutral` covers states with no outstanding action (already
// queued/sent/following-up automatically, or already converted).
const STATUS_RECOMMENDATION: Record<ProspectStatus, Recommendation> = {
  new: { label: 'Enrich', tone: 'green' },
  enriched: { label: 'Draft', tone: 'green' },
  drafted: { label: 'Review in queue', tone: 'green' },
  queued: { label: 'Awaiting send', tone: 'neutral' },
  sent: { label: 'Awaiting reply', tone: 'neutral' },
  followup_1: { label: 'Awaiting reply', tone: 'neutral' },
  followup_2: { label: 'Awaiting reply', tone: 'neutral' },
  followup_3: { label: 'Awaiting reply', tone: 'neutral' },
  replied: { label: 'Win', tone: 'green' },
  won: { label: 'Converted', tone: 'neutral' },
  dead: { label: 'Ignore', tone: 'red' },
  unsubscribed: { label: 'Ignore', tone: 'red' },
};

const RECOMMENDATION_BADGE_VARIANT: Record<RecommendationTone, 'success' | 'destructive' | 'outline'> = {
  green: 'success',
  red: 'destructive',
  neutral: 'outline',
};

const RECOMMENDATION_ICON: Record<RecommendationTone, typeof CheckmarkCircle02Icon> = {
  green: CheckmarkCircle02Icon,
  red: AlertCircleIcon,
  neutral: Clock01Icon,
};

function getRecommendation(prospect: ProspectListItem): Recommendation {
  if (isLikelyLowValue(prospect)) return { label: 'Ignore', tone: 'red' };
  return STATUS_RECOMMENDATION[prospect.status];
}

type BulkActionKind = 'seen' | 'unseen' | 'enrich' | 'draft' | 'match' | 'win' | 'delete';

const BULK_ACTION_LABEL: Record<BulkActionKind, string> = {
  seen: 'Mark seen',
  unseen: 'Mark unseen',
  enrich: 'Enrich',
  draft: 'Draft',
  match: 'Match',
  win: 'Win',
  delete: 'Delete',
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
  // Bumped after any action inside the detail dialog succeeds, to
  // re-trigger the load effect below so status/priorityScore/sentAt reflect
  // the change from the server.
  const [refreshIndex, setRefreshIndex] = useState(0);
  // Which prospect's detail dialog is open, if any. Every per-prospect
  // action (Enrich/Draft/Match/Win) now lives inside that dialog - see
  // prospect-detail-dialog.tsx - rather than as buttons in this table.
  const [selectedProspectId, setSelectedProspectId] = useState<string | null>(null);

  // Bulk-select state - mirrors approval-queue-table.tsx's Set<string>
  // pattern rather than TanStack Table's built-in row-selection feature, for
  // consistency with the one other bulk-action table in this app.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkActionPending, setBulkActionPending] = useState<BulkActionKind | null>(null);
  // Enrich/Draft cost real external API calls, and Delete is irreversible,
  // so all three require an extra confirmation step before running - see
  // confirmBulkAction below.
  const [confirmBulkAction, setConfirmBulkAction] = useState<'enrich' | 'draft' | 'delete' | null>(null);

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
        // The previously selected ids may no longer be on the page (new
        // filters/sort/cursor, or a refresh after a bulk action already
        // consumed them) - start the next page with a clean selection
        // rather than a stale one, matching approval-queue-table.tsx.
        setSelected(new Set());
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

  function toggleSelected(prospectId: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(prospectId)) next.delete(prospectId);
      else next.add(prospectId);
      return next;
    });
  }


  async function runBulkAction(kind: BulkActionKind, run: (ids: string[]) => Promise<BulkActionResult[]>): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;

    setBulkActionPending(kind);
    try {
      const results = await run(ids);
      toastBulkResults(BULK_ACTION_LABEL[kind], results, prospects);
      setSelected(new Set());
      setRefreshIndex((prev) => prev + 1);
    } catch (err) {
      toastError(`Bulk ${BULK_ACTION_LABEL[kind].toLowerCase()} failed`, errorMessage(err));
    } finally {
      setBulkActionPending(null);
    }
  }

  function handleBulkMarkSeen(seen: boolean): void {
    void runBulkAction(seen ? 'seen' : 'unseen', (ids) => bulkSetProspectsSeen(ids, seen));
  }

  function handleConfirmBulkAction(): void {
    const kind = confirmBulkAction;
    setConfirmBulkAction(null);
    if (kind === 'enrich') void runBulkAction('enrich', bulkEnrichProspects);
    if (kind === 'draft') void runBulkAction('draft', bulkDraftProspects);
    if (kind === 'delete') void runBulkAction('delete', bulkDeleteProspects);
  }

  function handleToggleSeen(prospectId: string, seen: boolean): void {
    // Optimistic, silent, no refetch: this is a read marker for the user's
    // own benefit, not pipeline state, so it shouldn't feel like an "action"
    // (no toast, no loading state on the row's other buttons).
    setProspects((prev) => prev.map((p) => (p.id === prospectId ? { ...p, seen } : p)));
    setProspectSeen(prospectId, seen).catch(() => {
      setProspects((prev) => prev.map((p) => (p.id === prospectId ? { ...p, seen: !seen } : p)));
    });
  }

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

  function setSortField(field: SortField): void {
    handleSortingChange([{ id: field, desc: sorting[0]?.desc ?? true }]);
  }

  function toggleSortDirection(): void {
    handleSortingChange([{ id: sorting[0]?.id ?? 'discoveredAt', desc: !(sorting[0]?.desc ?? true) }]);
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
        id: 'select',
        header: () => (
          <Checkbox
            checked={prospects.length > 0 && selected.size === prospects.length}
            disabled={prospects.length === 0}
            onCheckedChange={() => {
              const visibleIds = prospects.map((p) => p.id);
              setSelected((prev) => (prev.size === visibleIds.length ? new Set() : new Set(visibleIds)));
            }}
            aria-label="Select all"
          />
        ),
        enableHiding: false,
        size: 40,
        cell: ({ row }) => (
          <Checkbox
            checked={selected.has(row.original.id)}
            onCheckedChange={() => toggleSelected(row.original.id)}
            aria-label={`Select ${row.original.companyName}`}
          />
        ),
      },
      {
        id: 'seen',
        header: 'Seen',
        enableHiding: false,
        size: 48,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleToggleSeen(row.original.id, !row.original.seen)}
            aria-label={row.original.seen ? 'Mark as unseen' : 'Mark as seen'}
          >
            <HugeiconsIcon icon={row.original.seen ? EyeOffIcon : EyeIcon} strokeWidth={2} />
          </Button>
        ),
      },
      {
        accessorKey: 'companyName',
        header: 'Company',
        enableHiding: false,
        size: 200,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-1.5">
            {!row.original.seen ? (
              <HugeiconsIcon
                icon={DotIcon}
                strokeWidth={2}
                className="text-primary size-3 shrink-0"
                aria-label="Unseen"
              />
            ) : null}
            <button
              type="button"
              className="min-w-0 truncate text-left text-white underline underline-offset-2"
              onClick={() => setSelectedProspectId(row.original.id)}
            >
              {row.original.companyName}
            </button>
            {row.original.lastDraftFailure ? (
              <Badge variant="destructive" className="shrink-0">
                Draft failed
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'signal',
        // Deliberately the one column with no `size` - see `tableClassName="table-fixed"`
        // below: under a fixed table layout, the column left without an explicit
        // width absorbs all the space the other (narrow, fixed-width) columns
        // don't use, instead of every column stretching evenly and leaving gaps.
        header: ({ column }) => <DataTableColumnHeader column={column} label="Signal : Reason" />,
        meta: { label: 'Signal : Reason' },
        cell: ({ row }) => (
          <span className="flex min-w-0 items-start gap-1.5">
            <Badge variant={SIGNAL_STRENGTH_BADGE_VARIANT[row.original.signal.strength]} className="shrink-0">
              <HugeiconsIcon icon={SIGNAL_STRENGTH_ICON[row.original.signal.strength]} data-icon="inline-start" strokeWidth={2} />
              {SIGNAL_STRENGTH_LABEL[row.original.signal.strength]}
            </Badge>
            <span className="whitespace-normal break-words">{row.original.signal.description}</span>
          </span>
        ),
      },
      {
        accessorKey: 'projectFit',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Project fit" />,
        meta: { label: 'Project fit' },
        size: 140,
        cell: ({ row }) => <span className="block truncate">{formatEnumLabel(row.original.projectFit)}</span>,
      },
      {
        accessorKey: 'status',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Status" />,
        meta: { label: 'Status' },
        size: 120,
        cell: ({ row }) =>
          row.original.status === 'enriched' ? (
            <Badge variant="success">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} data-icon="inline-start" strokeWidth={2} />
              {formatEnumLabel(row.original.status)}
            </Badge>
          ) : (
            <span className="block truncate">{formatEnumLabel(row.original.status)}</span>
          ),
      },
      {
        accessorKey: 'sentAt',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Sent" />,
        meta: { label: 'Sent' },
        enableSorting: true,
        size: 120,
        cell: ({ row }) => formatDate(row.original.sentAt),
      },
      {
        id: 'recommendedAction',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Recommended Action" />,
        meta: { label: 'Recommended Action' },
        size: 160,
        cell: ({ row }) => {
          const recommendation = getRecommendation(row.original);
          return (
            <Badge variant={RECOMMENDATION_BADGE_VARIANT[recommendation.tone]}>
              <HugeiconsIcon icon={RECOMMENDATION_ICON[recommendation.tone]} data-icon="inline-start" strokeWidth={2} />
              {recommendation.label}
            </Badge>
          );
        },
      },
    ],
    // `prospects`/`selected` deliberately included: the select column's
    // header/row checkboxes read both directly (not through row data), so
    // they'd otherwise render a stale checked state after either changes.
    [prospects, selected]
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
        <p className="text-muted-foreground text-sm">
          Every lead discovery has found, ready to enrich, draft, and send. Click a company name for full details.
        </p>
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
        <div className="flex flex-col gap-1">
          <label className="text-muted-foreground text-xs">Reason contains</label>
          <Input
            className="w-48"
            placeholder="e.g. outdated, no HTTPS"
            value={filters.reason}
            onChange={(event) => updateFilter('reason', event.target.value)}
          />
        </div>
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
        <FilterSelect
          label="Draft failure"
          value={filters.hasDraftFailure}
          options={['true', 'false']}
          onChange={(value) => updateFilter('hasDraftFailure', value as FiltersState['hasDraftFailure'])}
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
        <div className="flex flex-col gap-1">
          <label className="text-muted-foreground text-xs">Sort by</label>
          <div className="flex items-center gap-1">
            <Select value={sorting[0]?.id ?? 'discoveredAt'} onValueChange={(value) => setSortField(value as SortField)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_FIELDS.map((field) => (
                  <SelectItem key={field} value={field}>
                    {SORT_FIELD_LABELS[field]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={toggleSortDirection} aria-label="Toggle sort direction">
              <HugeiconsIcon icon={sorting[0]?.desc ? ArrowDown01Icon : ArrowUp01Icon} strokeWidth={2} />
            </Button>
          </div>
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

      {selected.size > 0 ? (
        <div className="bg-card flex flex-wrap items-center gap-2 rounded-lg p-3 ring-1 ring-foreground/10">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkActionPending !== null}
            onClick={() => handleBulkMarkSeen(true)}
          >
            {bulkActionPending === 'seen' ? 'Marking seen…' : 'Mark seen'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkActionPending !== null}
            onClick={() => handleBulkMarkSeen(false)}
          >
            {bulkActionPending === 'unseen' ? 'Marking unseen…' : 'Mark unseen'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkActionPending !== null}
            onClick={() => setConfirmBulkAction('enrich')}
          >
            {bulkActionPending === 'enrich' ? 'Enriching…' : 'Enrich selected'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkActionPending !== null}
            onClick={() => setConfirmBulkAction('draft')}
          >
            {bulkActionPending === 'draft' ? 'Drafting…' : 'Draft selected'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkActionPending !== null}
            onClick={() => void runBulkAction('match', bulkMatchProspects)}
          >
            {bulkActionPending === 'match' ? 'Matching…' : 'Match selected'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkActionPending !== null}
            onClick={() => void runBulkAction('win', bulkWinProspects)}
          >
            {bulkActionPending === 'win' ? 'Winning…' : 'Win selected'}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={bulkActionPending !== null}
            onClick={() => setConfirmBulkAction('delete')}
          >
            {bulkActionPending === 'delete' ? 'Deleting…' : 'Delete selected'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={bulkActionPending !== null}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      ) : null}

      <Dialog open={confirmBulkAction !== null} onOpenChange={(open) => !open && setConfirmBulkAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmBulkAction === 'draft' ? 'Draft' : confirmBulkAction === 'delete' ? 'Delete' : 'Enrich'} {selected.size} prospects?
            </DialogTitle>
            <DialogDescription>
              {confirmBulkAction === 'draft'
                ? `This will make up to ${selected.size} AI draft generation call${selected.size === 1 ? '' : 's'}.`
                : confirmBulkAction === 'delete'
                  ? `This will permanently delete ${selected.size} prospect${selected.size === 1 ? '' : 's'}. This cannot be undone.`
                  : `This will make up to ${selected.size} Hunter/People Data Labs lookup${selected.size === 1 ? '' : 's'}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmBulkAction(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmBulkAction === 'delete' ? 'destructive' : 'default'}
              onClick={handleConfirmBulkAction}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {error ? <p className="text-destructive text-sm">Couldn&apos;t load prospects: {error}</p> : null}

      {isLoading ? (
        <DataTableSkeleton columnCount={columns.length} rowCount={6} withViewOptions={false} />
      ) : (
        <DataTable
          table={table}
          // Fixed layout + every column but Signal:Reason declaring an
          // explicit `size` (see the columns above): the table still fills
          // the full width, but the narrow columns stay tight to their
          // content instead of stretching evenly and leaving gaps - the
          // Signal:Reason column absorbs whatever width is left over.
          tableClassName="table-fixed"
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

      <ProspectDetailDialog
        prospectId={selectedProspectId}
        onOpenChange={(open) => {
          if (!open) setSelectedProspectId(null);
        }}
        onChanged={() => setRefreshIndex((prev) => prev + 1)}
      />
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
