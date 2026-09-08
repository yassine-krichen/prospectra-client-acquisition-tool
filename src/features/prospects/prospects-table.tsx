'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { type ColumnDef, type SortingState, type VisibilityState, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { z } from 'zod';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Alert02Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Compass01Icon,
  DotIcon,
  EyeIcon,
  EyeOffIcon,
  StarIcon,
  StarOffIcon,
} from '@hugeicons/core-free-icons';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { DataTableViewOptions } from '@/components/data-table/data-table-view-options';
import { DataTableSkeleton } from '@/components/data-table/data-table-skeleton';
import { DataTableCursorPagination } from '@/components/data-table/data-table-pagination';
import { ProspectDetailDialog } from '@/features/prospects/prospect-detail-dialog';
import { SignalDetailDialog, type SelectedSignal } from '@/features/prospects/signal-detail-dialog';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  industrySchema,
  projectFitSchema,
  prospectListItemSchema,
  prospectSourceSchema,
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
  bulkSetProspectsFavorite,
  bulkSetProspectsSeen,
  bulkWinProspects,
  markProspectOpened,
  setProspectFavorite,
  setProspectSeen,
  type BulkActionResult,
} from '@/features/prospects/prospect-actions';

// Mirrors `ProspectSortField` in `prospects.repository.ts`. Duplicated
// (rather than imported) because that module pulls in the Prisma client,
// which must not end up in the client bundle.
type SortField = 'priorityScore' | 'discoveredAt' | 'sentAt';

const listProspectsResponseSchema = z.object({
  prospects: z.array(prospectListItemSchema),
  nextCursor: z.string().nullable(),
});

const listReasonsResponseSchema = z.object({ reasons: z.array(z.string()) });

// Sentinel used by the filter `Select`s in place of an empty string - Radix
// `Select.Item` requires a non-empty `value`.
const ALL = 'all';

// localStorage key for the "last opened prospect" row highlight - see
// `lastOpenedProspectId`/`openProspectDialog` below.
const LAST_OPENED_PROSPECT_STORAGE_KEY = 'biz-scraper:last-opened-prospect-id';

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
  hasDomain: typeof ALL | 'true' | 'false';
  opened: typeof ALL | 'true' | 'false';
  // Client-side-only convenience filter - translates to `seen=false` on the
  // wire (see buildQueryParams). Kept alongside the server-backed filters
  // above rather than as separate component state so `resetFilters`/the
  // cursor-reset-on-change behavior cover it for free.
  hideSeen: boolean;
  // Same shape as `hideSeen` above, but for the `favorite` flag - translates
  // to `favorite=true` on the wire (see buildQueryParams).
  favoriteOnly: boolean;
}

// Default view hides Low/Medium-signal prospects - see the note rendered
// above the filter bar. Still overridable via the Signal strength filter or
// "Clear filters" (which returns here, not to ALL - this is the default).
const DEFAULT_FILTERS: FiltersState = {
  source: ALL,
  signalType: ALL,
  signalStrength: 'strong',
  reason: '',
  industry: ALL,
  projectFit: ALL,
  hasDomain: ALL,
  opened: ALL,
  hideSeen: false,
  favoriteOnly: false,
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
  if (filters.hasDomain !== ALL) params.set('hasDomain', filters.hasDomain);
  if (filters.opened !== ALL) params.set('opened', filters.opened);
  if (filters.hideSeen) params.set('seen', 'false');
  if (filters.favoriteOnly) params.set('favorite', 'true');

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

// Backs the "Reason contains" filter's combobox - the distinct set of
// `signal.description` values that actually exist right now, so the
// dropdown suggests real values instead of an editor guessing free text.
async function fetchReasonOptions(): Promise<string[]> {
  const response = await fetch('/api/prospects/reasons');
  if (!response.ok) {
    throw new Error(`Failed to load reason options (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return listReasonsResponseSchema.parse(body).reasons;
}

// Replaces the old Status column - a prospect's pipeline status is still
// used elsewhere (see STATUS_RECOMMENDATION below, which drives the
// Recommended Action column), just no longer surfaced as its own column or
// filter here. Calendar-day difference (not a raw 24h-bucket one), so a
// prospect discovered at 11pm yesterday reads "1 day ago" rather than
// "Today" just because it's within the last 24 hours.
function formatDiscovered(discoveredAt: Date): string {
  const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(discoveredAt)) / (1000 * 60 * 60 * 24));

  const relative = daysAgo <= 0 ? 'Today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
  return `${discoveredAt.toLocaleDateString()} · ${relative}`;
}

// Formats a cents integer as whole dollars, e.g. 150000 -> "1,500". Mirrors
// `formatCents` in client-detail.tsx (duplicated rather than imported - that
// file transitively pulls in client-side action helpers this file doesn't
// need, and this repo's convention is to duplicate small client-safe
// formatters rather than share them across features).
function formatDollars(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatCentsRange(range: { min: number; max: number }): string {
  return `$${formatDollars(range.min)}–${formatDollars(range.max)}`;
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
  // Every enrichment source (Hunter, People Data Labs, pattern-guess + MX)
  // requires a domain to search against - `enrichProspect` itself
  // short-circuits with "prospect has no domain to enrich against" for
  // these, so recommending "Enrich" here would send a human to click a
  // button guaranteed to no-op. Common, not an edge case: OpenStreetMap,
  // Yellow Pages, and Google Places all produce a strong "no website"
  // signal specifically because the business has none, and both registry
  // sources (Companies House, Texas Comptroller) never carry a website at
  // all.
  if (prospect.status === 'new' && !prospect.domain && !prospect.websiteUrl) {
    // A domain-less prospect isn't necessarily a dead end - Yellow Pages
    // and OpenStreetMap (the two sources most likely to produce one) often
    // still capture a phone number, a real alternate contact channel none
    // of the enrichment sources need a domain for. Only fall back to "no
    // path yet" when there's genuinely nothing to act on.
    if (prospect.phone) {
      return { label: `Call ${prospect.phone}`, tone: 'green' };
    }
    return { label: 'Find website first', tone: 'neutral' };
  }
  return STATUS_RECOMMENDATION[prospect.status];
}

type BulkActionKind = 'seen' | 'unseen' | 'favorite' | 'unfavorite' | 'enrich' | 'draft' | 'match' | 'win' | 'delete';

const BULK_ACTION_LABEL: Record<BulkActionKind, string> = {
  seen: 'Mark seen',
  unseen: 'Mark unseen',
  favorite: 'Favorite',
  unfavorite: 'Unfavorite',
  enrich: 'Enrich',
  draft: 'Draft',
  match: 'Match',
  win: 'Win',
  delete: 'Delete',
};

export function ProspectsTable(): React.JSX.Element {
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS);
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING);
  // `projectFit` stays a real column (the `FilterSelect` above still filters
  // on it), but is hidden by default now that Pitch/Budget cover the same
  // ground more usefully - a user can still re-enable it via "View options".
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ projectFit: false });
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  // History of cursors used to reach the current page. Empty = first page.
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [prospects, setProspects] = useState<ProspectListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Bumped after any action inside the detail dialog succeeds, to
  // re-trigger the load effect below so status/priorityScore/sentAt reflect
  // the change from the server.
  const [refreshIndex, setRefreshIndex] = useState(0);
  // Which prospect's detail dialog is open, if any. Every per-prospect
  // action (Enrich/Draft/Match/Win) now lives inside that dialog - see
  // prospect-detail-dialog.tsx - rather than as buttons in this table.
  const [selectedProspectId, setSelectedProspectId] = useState<string | null>(null);
  // Which prospect's signal detail dialog is open, if any - see
  // signal-detail-dialog.tsx.
  const [selectedSignal, setSelectedSignal] = useState<SelectedSignal | null>(null);
  // The last prospect whose dialog was opened, kept highlighted in the table
  // after the dialog closes so re-finding it in a long list doesn't mean
  // re-scanning company names from scratch. Starts `null` (matches the
  // server-rendered markup) and is hydrated from localStorage in an effect
  // rather than a lazy useState initializer, so this never diverges from
  // what was server-rendered during hydration - it's private to this
  // browser, never shared with or persisted by the server.
  const [lastOpenedProspectId, setLastOpenedProspectId] = useState<string | null>(null);

  useEffect(() => {
    try {
      setLastOpenedProspectId(window.localStorage.getItem(LAST_OPENED_PROSPECT_STORAGE_KEY));
    } catch {
      // Private browsing / storage disabled - no highlight, not fatal.
    }
  }, []);

  function openProspectDialog(prospectId: string): void {
    setSelectedProspectId(prospectId);
    setLastOpenedProspectId(prospectId);
    try {
      window.localStorage.setItem(LAST_OPENED_PROSPECT_STORAGE_KEY, prospectId);
    } catch {
      // Private browsing / storage disabled - the in-memory state above
      // still highlights it for the rest of this page view either way.
    }

    // Records the open server-side for the "Opened" column - who opened it
    // comes back from the server (the session cookie's nickname), not
    // something this client component already knows. Best-effort: a failure
    // here shouldn't block the dialog the user is already looking at.
    markProspectOpened(prospectId)
      .then(({ lastOpenedAt, lastOpenedByNickname }) => {
        setProspects((prev) =>
          prev.map((p) => (p.id === prospectId ? { ...p, lastOpenedAt, lastOpenedByNickname } : p))
        );
      })
      .catch(() => {
        // Non-fatal - see the comment above.
      });
  }

  // Distinct reason values fetched once for the "Reason contains" combobox
  // (see ReasonFilterCombobox below) - loaded independently of the
  // paginated prospects fetch below since it isn't affected by filters/sort/
  // cursor. Failure just leaves the dropdown empty; free-text substring
  // filtering (the field's original behavior) still works either way.
  const [reasonOptions, setReasonOptions] = useState<string[]>([]);

  useEffect(() => {
    fetchReasonOptions()
      .then(setReasonOptions)
      .catch(() => {
        // Non-fatal - see the comment on `reasonOptions` above.
      });
  }, []);

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
        if (!cancelled) toastError('Failed to load prospects', errorMessage(err));
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

  function handleBulkMarkFavorite(favorite: boolean): void {
    void runBulkAction(favorite ? 'favorite' : 'unfavorite', (ids) => bulkSetProspectsFavorite(ids, favorite));
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

  function handleToggleFavorite(prospectId: string, favorite: boolean): void {
    // Optimistic, silent, no refetch: this is a pin marker for the user's
    // own benefit, not pipeline state, so it shouldn't feel like an "action"
    // (no toast, no loading state on the row's other buttons).
    setProspects((prev) => prev.map((p) => (p.id === prospectId ? { ...p, favorite } : p)));
    setProspectFavorite(prospectId, favorite).catch(() => {
      setProspects((prev) => prev.map((p) => (p.id === prospectId ? { ...p, favorite: !favorite } : p)));
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
        id: 'favorite',
        header: 'Favorite',
        enableHiding: false,
        size: 48,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleToggleFavorite(row.original.id, !row.original.favorite)}
            aria-label={row.original.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <HugeiconsIcon icon={row.original.favorite ? StarIcon : StarOffIcon} strokeWidth={2} />
          </Button>
        ),
      },
      {
        accessorKey: 'companyName',
        header: 'Company',
        enableHiding: false,
        size: 140,
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
              className="min-w-0 truncate text-left text-primary underline underline-offset-2 dark:text-white"
              onClick={() => openProspectDialog(row.original.id)}
            >
              {row.original.companyName}
            </button>
            {row.original.source === 'ai_agent' ? (
              <Badge variant="secondary" className="shrink-0">
                AI
              </Badge>
            ) : null}
            {row.original.lastDraftFailure ? (
              <Badge variant="destructive" className="shrink-0">
                Draft failed
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'opened',
        header: 'Opened',
        enableHiding: false,
        // Compact and placed right after Company (rather than further right,
        // near Sent/Recommended Action) specifically so it's visible without
        // horizontal scroll on a typical viewport - see `tableClassName="table-fixed"`
        // below: every column's `size` is part of a deliberately small total
        // budget so the table stays within a typical viewport - see the
        // comment on the Signal column's own `size` for why.
        size: 95,
        cell: ({ row }) =>
          row.original.lastOpenedAt && row.original.lastOpenedByNickname ? (
            // `whitespace-normal break-words` on every line - without it,
            // `TableCell`'s default `whitespace-nowrap` lets a long
            // date/time string visibly bleed past this column's narrow
            // fixed width into the next column instead of wrapping
            // (verified live - it overlapped the Domain column's text).
            // Date and time are split onto their own lines (rather than one
            // `toLocaleString()` call) so each line is short enough to fit
            // without wrapping at all in the common case.
            <span className="flex flex-col text-xs leading-tight whitespace-normal">
              <span className="text-sm font-medium">Yes</span>
              <span className="text-muted-foreground break-words">{row.original.lastOpenedAt.toLocaleDateString()}</span>
              <span className="text-muted-foreground break-words">{row.original.lastOpenedAt.toLocaleTimeString()}</span>
              <span className="text-muted-foreground break-words">by {row.original.lastOpenedByNickname}</span>
            </span>
          ) : (
            <span className="text-muted-foreground text-sm font-medium">No</span>
          ),
      },
      {
        id: 'domain',
        header: 'Domain',
        enableHiding: false,
        // Compact, same reasoning as the Opened column above re: staying
        // within the viewport without horizontal scroll.
        size: 55,
        cell: ({ row }) => (row.original.domain ? 'Yes' : 'No'),
      },
      {
        id: 'signal',
        // Explicit `size`, not left auto - under `tableClassName="table-fixed"`,
        // a column with no `size` does NOT absorb leftover space (verified
        // live - it takes only its own header label's natural width and the
        // *sum* of every column's `size` becomes the table's real total
        // width). Every column here has a deliberately small explicit size
        // so the total stays under ~990px, fitting a 1280px-wide browser
        // window without the table needing its own horizontal scrollbar.
        size: 200,
        header: ({ column }) => <DataTableColumnHeader column={column} label="Signal : Reason" />,
        meta: { label: 'Signal : Reason' },
        cell: ({ row }) => (
          <span className="flex min-w-0 items-start gap-1.5">
            <Badge variant={SIGNAL_STRENGTH_BADGE_VARIANT[row.original.signal.strength]} className="shrink-0">
              <HugeiconsIcon icon={SIGNAL_STRENGTH_ICON[row.original.signal.strength]} data-icon="inline-start" strokeWidth={2} />
              {SIGNAL_STRENGTH_LABEL[row.original.signal.strength]}
            </Badge>
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left underline underline-offset-2"
              onClick={() =>
                setSelectedSignal({
                  signal: row.original.signal,
                  companyName: row.original.companyName,
                  sourceUrl: row.original.sourceUrl,
                })
              }
            >
              {row.original.signal.description}
            </button>
          </span>
        ),
      },
      {
        accessorKey: 'projectFit',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Fit" />,
        meta: { label: 'Project fit' },
        size: 70,
        cell: ({ row }) => <span className="block truncate">{formatEnumLabel(row.original.projectFit)}</span>,
      },
      {
        id: 'pitch',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Pitch" />,
        meta: { label: 'Pitch' },
        size: 160,
        cell: ({ row }) => {
          const primary = row.original.suggestedServices.find((s) => s.role === 'primary');
          if (!primary) return <span className="text-muted-foreground block truncate">Unclear</span>;
          return (
            <Badge variant="outline" className="max-w-full" title={primary.reasoning}>
              <span className="truncate">{formatEnumLabel(primary.service)}</span>
            </Badge>
          );
        },
      },
      {
        id: 'budget',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Budget" />,
        meta: { label: 'Budget' },
        size: 140,
        cell: ({ row }) => {
          const primary = row.original.suggestedServices.find((s) => s.role === 'primary');
          if (primary && !primary.requiresManualQuote && primary.priceRangeCents) {
            return <span className="block truncate">{formatCentsRange(primary.priceRangeCents)}</span>;
          }
          return <span className="text-muted-foreground block truncate">{formatEnumLabel(row.original.estimatedBudget)}</span>;
        },
      },
      {
        accessorKey: 'discoveredAt',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Discovered" />,
        meta: { label: 'Discovered' },
        size: 80,
        cell: ({ row }) => <span className="block truncate">{formatDiscovered(row.original.discoveredAt)}</span>,
      },
      {
        accessorKey: 'sentAt',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Sent" />,
        meta: { label: 'Sent' },
        enableSorting: true,
        size: 48,
        cell: ({ row }) => (row.original.sentAt ? 'Yes' : 'No'),
      },
      {
        id: 'recommendedAction',
        header: ({ column }) => <DataTableColumnHeader column={column} label="Action" />,
        meta: { label: 'Recommended Action' },
        size: 115,
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
        <p className="text-muted-foreground text-sm">
          Showing High signal strength only by default - use the Signal strength filter below to see Low/Medium too.
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
        <ReasonFilterCombobox
          value={filters.reason}
          options={reasonOptions}
          onChange={(value) => updateFilter('reason', value)}
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
        <BooleanFilterSelect
          label="Has domain"
          value={filters.hasDomain}
          onChange={(value) => updateFilter('hasDomain', value)}
        />
        <BooleanFilterSelect label="Opened" value={filters.opened} onChange={(value) => updateFilter('opened', value)} />
        <label className="flex h-8 items-center gap-2 text-sm">
          <Checkbox checked={filters.hideSeen} onCheckedChange={(checked) => updateFilter('hideSeen', checked === true)} />
          Hide seen
        </label>
        <label className="flex h-8 items-center gap-2 text-sm">
          <Checkbox
            checked={filters.favoriteOnly}
            onCheckedChange={(checked) => updateFilter('favoriteOnly', checked === true)}
          />
          Favorites only
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
            onClick={() => handleBulkMarkFavorite(true)}
          >
            {bulkActionPending === 'favorite' ? 'Favoriting…' : 'Favorite'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkActionPending !== null}
            onClick={() => handleBulkMarkFavorite(false)}
          >
            {bulkActionPending === 'unfavorite' ? 'Unfavoriting…' : 'Unfavorite'}
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

      {isLoading ? (
        <DataTableSkeleton columnCount={columns.length} rowCount={6} withViewOptions={false} />
      ) : (
        <DataTable
          table={table}
          // Fixed layout, every column declares an explicit `size` (see the
          // columns above) - keeping `DataTable`'s default `w-full` matters:
          // dropping it (tried `w-auto`, reverted) lets cell content expand
          // a column past its declared `size` since there's no longer a
          // hard total-width constraint forcing `table-layout: fixed` to
          // clamp it. The real remaining source of horizontal overflow
          // (tried and reverted an `overflow-x-hidden` hack here, which just
          // silently clipped real header text instead of fixing anything -
          // see the shortened column labels below) was header labels wider
          // than their column's narrow rescaled width: `TableHead` is
          // `whitespace-nowrap`, so a header that doesn't fit bleeds past
          // its column boundary instead of wrapping, which is what was
          // actually inflating the table's scrollable width.
          tableClassName="table-fixed"
          getRowClassName={(row) =>
            cn(
              row.original.seen && 'opacity-50',
              row.original.id === lastOpenedProspectId &&
                'bg-primary/10 hover:bg-primary/15 dark:bg-primary/20 dark:hover:bg-primary/30'
            )
          }
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

      <SignalDetailDialog
        selected={selectedSignal}
        onOpenChange={(open) => {
          if (!open) setSelectedSignal(null);
        }}
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

interface BooleanFilterSelectProps {
  label: string;
  value: typeof ALL | 'true' | 'false';
  onChange: (value: typeof ALL | 'true' | 'false') => void;
}

// Same shape as `FilterSelect`, but for the `'true' | 'false'` wire-format
// boolean filters (Has domain, Opened) - shows "Yes"/"No" instead of the raw
// string values, which `FilterSelect` would otherwise render verbatim.
function BooleanFilterSelect({ label, value, onChange }: BooleanFilterSelectProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-muted-foreground text-xs">{label}</label>
      <Select value={value} onValueChange={(next) => onChange(next as typeof ALL | 'true' | 'false')}>
        <SelectTrigger className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

const REASON_COMBOBOX_MAX_SUGGESTIONS = 50;

interface ReasonFilterComboboxProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

// Free-text "contains" filter (see `FiltersState.reason`'s doc comment) with
// a combobox layered on top, suggesting the distinct `signal.description`
// values that actually exist right now (`reasonOptions`, fetched once via
// `fetchReasonOptions`). Deliberately keeps the plain `Input` as the source
// of truth rather than routing through `CommandInput` - typing still filters
// the table by substring exactly as before; the dropdown is a discoverable
// shortcut on top; not a constraint to only these exact values.
function ReasonFilterCombobox({ value, options, onChange }: ReasonFilterComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const suggestions = useMemo(() => {
    const query = value.trim().toLowerCase();
    const matches = query === '' ? options : options.filter((option) => option.toLowerCase().includes(query));
    return matches.slice(0, REASON_COMBOBOX_MAX_SUGGESTIONS);
  }, [options, value]);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-muted-foreground text-xs">Reason contains</label>
      <Popover open={open} onOpenChange={setOpen}>
        {/* `PopoverAnchor`, not `PopoverTrigger` - Radix's Trigger primitive
            forces `type="button"` onto whatever it wraps via `asChild`,
            which silently turns this text `Input` unfocusable/untypable.
            `Popover.Anchor` positions the popover the same way without
            touching the child's props; `open` is driven manually below via
            onFocus/onChange instead of Radix's own click-to-toggle. */}
        <PopoverAnchor asChild>
          <Input
            className="w-48"
            placeholder="e.g. outdated, no HTTPS"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-(--radix-popover-trigger-width) p-0"
          align="start"
          // Keeps focus in the `Input` above so typing isn't interrupted the
          // moment the dropdown opens - same reason the login page's account
          // combobox doesn't apply here (that one's trigger is a button, not
          // an editable field).
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Command shouldFilter={false}>
            <CommandList>
              <CommandEmpty>No matching reason yet.</CommandEmpty>
              <CommandGroup>
                {suggestions.map((option) => (
                  <CommandItem
                    key={option}
                    value={option}
                    onSelect={() => {
                      onChange(option);
                      setOpen(false);
                    }}
                  >
                    {option}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
