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
  ProspectComment,
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
  phone: true,
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
  lastOpenedAt: true,
  lastOpenedByNickname: true,
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
  /** Case-insensitive substring match against `signal.description` (the
   * "Reason" half of the prospects table's "Signal : Reason" column) - free
   * text, not an enum, since `description` is human-authored prose. */
  reason?: string;
  industry?: Industry;
  projectFit?: ProjectFit;
  status?: ProspectStatus;
  priorityScoreMin?: number;
  priorityScoreMax?: number;
  hasVerifiedEmail?: boolean;
  seen?: boolean;
  hasDraftFailure?: boolean;
  /** Whether `domain` is set - see the "Domain" column in prospects-table.tsx. */
  hasDomain?: boolean;
  /** Whether `lastOpenedAt` is set - see the "Opened" column in prospects-table.tsx. */
  opened?: boolean;
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
  // `domain`/`lastOpenedAt` are plain nullable scalar columns (not JSON like
  // `lastDraftFailure` above), so a direct `{ not: null }`/`{ equals: null }`
  // works without `Prisma.DbNull`.
  if (filters.hasDomain !== undefined) {
    where.domain = filters.hasDomain ? { not: null } : { equals: null };
  }
  if (filters.opened !== undefined) {
    where.lastOpenedAt = filters.opened ? { not: null } : { equals: null };
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
  if (filters.reason) {
    and.push({ signal: { path: ['description'], string_contains: filters.reason, mode: 'insensitive' } });
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
  phone: true,
  address: true,
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
  lastOpenedAt: true,
  lastOpenedByNickname: true,
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
  comments: {
    orderBy: { createdAt: 'desc' },
    select: { id: true, body: true, authorNickname: true, createdAt: true },
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

/**
 * Distinct `signal.description` values across every prospect, alphabetical -
 * backs the "Reason contains" filter's combobox on `/prospects` so it
 * suggests real values instead of an editor having to guess free text.
 * `signal` is a JSON column (see the model's own comment), so this needs a
 * raw JSON-path query rather than Prisma's `distinct`, which can't reach
 * inside JSON columns.
 */
export async function listDistinctReasons(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ reason: string }>>`
    SELECT DISTINCT signal->>'description' AS reason
    FROM "Prospect"
    WHERE signal->>'description' IS NOT NULL
    ORDER BY reason
  `;
  return rows.map((row) => row.reason);
}

/** Full detail fetch for the prospect detail dialog. `null` if no prospect exists with `id`. */
export async function getProspectById(id: string): Promise<Prospect | null> {
  const row = await prisma.prospect.findUnique({ where: { id }, select: FULL_PROSPECT_SELECT });
  return row ? toFullProspect(row) : null;
}

/**
 * Adds a free-text comment to a Prospect - see the doc comment on
 * `ProspectComment` in prisma/schema.prisma. `authorNickname` is resolved
 * by the caller (the route handler, from the session cookie) - this
 * function trusts whatever it's given rather than re-deriving it, since
 * only the route has access to the request's cookies. `null` if no
 * prospect exists with `id` (checked explicitly rather than relying on the
 * FK constraint to fail, so the caller gets a clean "not found" instead of
 * a raw Prisma error).
 */
export async function addProspectComment(
  id: string,
  body: string,
  authorNickname: string
): Promise<ProspectComment | null> {
  const prospect = await prisma.prospect.findUnique({ where: { id }, select: { id: true } });
  if (!prospect) return null;

  return prisma.prospectComment.create({
    data: { prospectId: id, body, authorNickname },
    select: { id: true, body: true, authorNickname: true, createdAt: true },
  });
}

export type DeleteProspectOutcome =
  | { outcome: 'deleted'; id: string }
  | { outcome: 'not_found' }
  | { outcome: 'blocked_do_not_contact' };

/**
 * Permanently deletes a Prospect - a real hard delete, not a soft-delete
 * flag, per this app's "soft deletes only when explicitly required"
 * preference. `doNotContact` blocks deletion regardless of `status`, same
 * compliance decision `convertProspectToClient` makes for "win" - erasing a
 * DNC prospect would erase the record that the company opted out, letting a
 * future re-discovery re-contact them. `findUnique` performs the initial
 * existence/`doNotContact` check, then `deleteMany` (rather than `delete`)
 * performs the actual delete, conditioned again on `doNotContact: false` -
 * that repeated condition on the delete itself is the atomic guard against
 * a `doNotContact` flip that races between the check and the delete: if the
 * flag flips to true in between, `deleteMany` matches zero rows instead of
 * deleting, and this function reports `not_found` rather than `deleted`,
 * same principle as `convertProspectToClient`'s claim-via-`updateMany`.
 * `Client.prospectId` has no explicit `onDelete` in the schema - the
 * relation is simply detached (set null) rather than blocking the delete,
 * which is expected/accepted here.
 */
export async function deleteProspect(id: string): Promise<DeleteProspectOutcome> {
  const prospect = await prisma.prospect.findUnique({ where: { id }, select: { doNotContact: true } });
  if (!prospect) return { outcome: 'not_found' };
  if (prospect.doNotContact) return { outcome: 'blocked_do_not_contact' };

  const { count } = await prisma.prospect.deleteMany({ where: { id, doNotContact: false } });
  return count > 0 ? { outcome: 'deleted', id } : { outcome: 'not_found' };
}
