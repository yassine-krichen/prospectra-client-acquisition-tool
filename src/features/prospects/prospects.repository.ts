import { Prisma } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { fromPrismaCompanySize } from '@/features/prospects/company-size.mapper';
import { fromPrismaModelUsed } from '@/features/drafting/model-used.mapper';
import type {
  DraftFailure,
  Industry,
  Location,
  Prospect,
  ProjectFit,
  ProspectListItem,
  ProspectSource,
  ProspectStatus,
  ServiceSuggestion,
  Signal,
  SignalStrength,
  SignalType,
  StatusHistoryEntry,
} from '@/features/prospects/prospect.types';

// Explicit projection matching `ProspectListItem` - the list view never
// needs drafts, statusHistory, contact details, or follow-up/reply
// tracking, so those columns aren't selected (see "Explicit data
// selection" in engineering standards).
const LIST_ITEM_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  companyName: true,
  domain: true,
  websiteUrl: true,
  industry: true,
  location: true,
  companySize: true,
  emailVerified: true,
  emailConfidence: true,
  source: true,
  sourceUrl: true,
  discoveredAt: true,
  signal: true,
  projectFit: true,
  estimatedBudget: true,
  suggestedServices: true,
  priorityScore: true,
  corroboratingSourceCount: true,
  status: true,
  sentAt: true,
  seen: true,
  lastDraftFailure: true,
} as const satisfies Prisma.ProspectSelect;

type ProspectListRow = Prisma.ProspectGetPayload<{ select: typeof LIST_ITEM_SELECT }>;

// `location`/`signal`/`suggestedServices` are untyped `Json` columns in the
// schema - this app only ever writes them in the `Location`/`Signal`/
// `ServiceSuggestion[]` shape, so it's safe to assert that shape back on
// read. Kept in sync by hand with `prospect.types.ts`, same as that file's
// own header comment describes.
function toListItem(row: ProspectListRow): ProspectListItem {
  return {
    ...row,
    companySize: fromPrismaCompanySize(row.companySize),
    location: row.location as Location,
    signal: row.signal as Signal,
    suggestedServices: row.suggestedServices as ServiceSuggestion[],
    lastDraftFailure: row.lastDraftFailure as DraftFailure | null,
  };
}

export type ProspectSortField = 'priorityScore' | 'discoveredAt' | 'sentAt';
export type SortDirection = 'asc' | 'desc';

export interface ListProspectsFilters {
  source?: ProspectSource;
  signalType?: SignalType;
  signalStrength?: SignalStrength;
  industry?: Industry;
  projectFit?: ProjectFit;
  status?: ProspectStatus;
  priorityScoreMin?: number;
  priorityScoreMax?: number;
  hasVerifiedEmail?: boolean;
  seen?: boolean;
  hasDraftFailure?: boolean;
}

export interface ListProspectsOptions {
  filters?: ListProspectsFilters;
  sortField?: ProspectSortField;
  sortDirection?: SortDirection;
  cursor?: string;
  limit?: number;
}

export interface ListProspectsResult {
  prospects: ProspectListItem[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// The cursor is keyed on the CURRENT `sortField`'s value (+ `id` as a
// tiebreak for equal values), not hardcoded to `createdAt`. Cursor-based
// pagination is only sound when the WHERE clause filters on the same field
// the results are ordered by - filtering on `createdAt` while sorting by
// `priorityScore`/`sentAt`/a `discoveredAt` that diverges from insertion
// order silently skips or repeats rows across pages. Callers aren't expected
// to change `sortField`/`sortDirection` mid-pagination - changing sort
// resets to page 1 in the UI - so a cursor is only ever re-decoded against
// the same sort it was encoded under.
interface DecodedCursor {
  sortValue: string | number | null;
  id: string;
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { sortValue, id } = decoded as Record<string, unknown>;
    if (typeof id !== 'string') return null;
    if (typeof sortValue !== 'string' && typeof sortValue !== 'number' && sortValue !== null) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

// `sentAt` is nullable and ordered with `nulls: 'last'` (see `listProspects`)
// regardless of sort direction, so a null-valued cursor row means "already
// in the trailing null bucket" - the next page is the rest of that bucket,
// tie-broken by `id` only. A non-null cursor value still needs an explicit
// `OR sentAt IS NULL` branch, since every null row sorts after it either way.
function buildCursorWhere(
  sortField: ProspectSortField,
  sortDirection: SortDirection,
  decoded: DecodedCursor
): Prisma.ProspectWhereInput {
  const valueCmp = sortDirection === 'asc' ? 'gt' : 'lt';
  const idCmp = sortDirection === 'asc' ? 'gt' : 'lt';

  if (sortField === 'sentAt') {
    if (decoded.sortValue === null) {
      return { sentAt: null, id: { [idCmp]: decoded.id } };
    }
    const value = new Date(decoded.sortValue);
    return {
      OR: [{ sentAt: { [valueCmp]: value } }, { sentAt: value, id: { [idCmp]: decoded.id } }, { sentAt: null }],
    };
  }

  if (sortField === 'discoveredAt') {
    const value = new Date(decoded.sortValue as string);
    return {
      OR: [{ discoveredAt: { [valueCmp]: value } }, { discoveredAt: value, id: { [idCmp]: decoded.id } }],
    };
  }

  const value = decoded.sortValue as number;
  return {
    OR: [{ priorityScore: { [valueCmp]: value } }, { priorityScore: value, id: { [idCmp]: decoded.id } }],
  };
}

function buildWhere(
  filters: ListProspectsFilters,
  sortField: ProspectSortField,
  sortDirection: SortDirection,
  cursor?: string
): Prisma.ProspectWhereInput {
  const where: Prisma.ProspectWhereInput = {};
  const and: Prisma.ProspectWhereInput[] = [];

  if (filters.source) where.source = filters.source;
  if (filters.industry) where.industry = filters.industry;
  if (filters.projectFit) where.projectFit = filters.projectFit;
  if (filters.status) where.status = filters.status;
  if (filters.hasVerifiedEmail !== undefined) where.emailVerified = filters.hasVerifiedEmail;
  if (filters.seen !== undefined) where.seen = filters.seen;
  if (filters.hasDraftFailure !== undefined) {
    where.lastDraftFailure = filters.hasDraftFailure ? { not: Prisma.DbNull } : { equals: Prisma.DbNull };
  }

  if (filters.priorityScoreMin !== undefined || filters.priorityScoreMax !== undefined) {
    where.priorityScore = {
      ...(filters.priorityScoreMin !== undefined ? { gte: filters.priorityScoreMin } : {}),
      ...(filters.priorityScoreMax !== undefined ? { lte: filters.priorityScoreMax } : {}),
    };
  }

  // `signal` is a single Json column holding { type, strength, ... }.
  // Prisma's Json filter only supports one `path`/`equals` pair per
  // condition, so type and strength filters (when both present) are
  // combined via a top-level AND rather than merged into one filter object.
  if (filters.signalType) {
    and.push({ signal: { path: ['type'], equals: filters.signalType } });
  }
  if (filters.signalStrength) {
    and.push({ signal: { path: ['strength'], equals: filters.signalStrength } });
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      and.push(buildCursorWhere(sortField, sortDirection, decoded));
    }
  }

  if (and.length > 0) where.AND = and;

  return where;
}

function extractSortValue(row: ProspectListRow, sortField: ProspectSortField): string | number | null {
  if (sortField === 'priorityScore') return row.priorityScore;
  if (sortField === 'discoveredAt') return row.discoveredAt.toISOString();
  return row.sentAt ? row.sentAt.toISOString() : null;
}

/**
 * Cursor-paginated, filterable, sortable prospect listing. Cursor is opaque
 * to callers (base64url-encoded `{ sortValue, id }` for whatever `sortField`
 * was in effect) - pass back the `nextCursor` from the previous response
 * unmodified to fetch the next page. Changing `sortField`/`sortDirection`
 * mid-pagination is unsupported - the caller must reset to page 1 first.
 */
export async function listProspects(options: ListProspectsOptions = {}): Promise<ListProspectsResult> {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const sortField = options.sortField ?? 'discoveredAt';
  const sortDirection = options.sortDirection ?? 'desc';

  const where = buildWhere(options.filters ?? {}, sortField, sortDirection, options.cursor);

  // `sentAt` is nullable: nulls are ordered last regardless of direction so
  // unsent prospects consistently sink to the bottom of the admin table
  // instead of jumping to the top on an ascending sort. `id` is the sole
  // tiebreaker (unique, so no third sort key is needed) and must be sorted
  // in the same direction the cursor comparison uses in `buildCursorWhere`.
  const orderBy: Prisma.ProspectOrderByWithRelationInput[] =
    sortField === 'sentAt'
      ? [{ sentAt: { sort: sortDirection, nulls: 'last' } }, { id: sortDirection }]
      : [{ [sortField]: sortDirection }, { id: sortDirection }];

  const rows = await prisma.prospect.findMany({
    where,
    orderBy,
    take: limit + 1,
    select: LIST_ITEM_SELECT,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ sortValue: extractSortValue(last, sortField), id: last.id }) : null;

  return { prospects: page.map(toListItem), nextCursor };
}

// Every column plus `drafts` - the detail dialog is the one place this app
// shows the FULL Prospect record (contact info, statusHistory, drafts,
// follow-up/reply tracking) rather than the trimmed `LIST_ITEM_SELECT`
// projection above.
const FULL_PROSPECT_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  companyName: true,
  domain: true,
  websiteUrl: true,
  industry: true,
  location: true,
  companySize: true,
  contactName: true,
  contactTitle: true,
  contactEmail: true,
  emailVerified: true,
  emailConfidence: true,
  linkedinUrl: true,
  source: true,
  sourceUrl: true,
  discoveredAt: true,
  signal: true,
  projectFit: true,
  estimatedBudget: true,
  suggestedServices: true,
  priorityScore: true,
  corroboratingSourceCount: true,
  status: true,
  statusHistory: true,
  seen: true,
  lastDraftFailure: true,
  activeDraftId: true,
  sentAt: true,
  lastFollowupAt: true,
  followupCount: true,
  repliedAt: true,
  replySentiment: true,
  doNotContact: true,
  unsubscribedAt: true,
  notes: true,
  tags: true,
  drafts: {
    orderBy: { variant: 'asc' },
  },
} as const satisfies Prisma.ProspectSelect;

type FullProspectRow = Prisma.ProspectGetPayload<{ select: typeof FULL_PROSPECT_SELECT }>;

function toFullProspect(row: FullProspectRow): Prospect {
  return {
    ...row,
    companySize: fromPrismaCompanySize(row.companySize),
    location: row.location as Location,
    signal: row.signal as Signal,
    suggestedServices: row.suggestedServices as ServiceSuggestion[],
    statusHistory: row.statusHistory as unknown as StatusHistoryEntry[],
    lastDraftFailure: row.lastDraftFailure as DraftFailure | null,
    drafts: row.drafts.map((draft) => ({ ...draft, modelUsed: fromPrismaModelUsed(draft.modelUsed) })),
  };
}

/** Full detail fetch for the prospect detail dialog. `null` if no prospect exists with `id`. */
export async function getProspectById(id: string): Promise<Prospect | null> {
  const row = await prisma.prospect.findUnique({ where: { id }, select: FULL_PROSPECT_SELECT });
  return row ? toFullProspect(row) : null;
}
