import { z } from 'zod';

import { draftSchema, prospectSchema, serviceSuggestionSchema, type Prospect } from '@/features/prospects/prospect.types';

// Client-safe fetch helpers + response schemas for the four per-prospect
// pipeline actions the dashboard exposes. Response shapes mirror each
// route's actual return type (see `app/api/prospects/[id]/*/route.ts`), not
// imported directly - those routes import server-only `.service.ts` modules.

// --- enrich ---

// Mirrors `EnrichProspectResult` in enrichment.types.ts.
const enrichResponseSchema = z.object({
  prospect: z.object({
    id: z.string(),
    companyName: z.string(),
    domain: z.string().nullable(),
    contactName: z.string().nullable(),
    contactTitle: z.string().nullable(),
    contactEmail: z.string().nullable(),
    emailVerified: z.boolean(),
    emailConfidence: z.number().int(),
    linkedinUrl: z.string().nullable(),
    status: z.string(),
    updatedAt: z.coerce.date(),
  }),
  sources: z.array(
    z.object({
      source: z.string(),
      ran: z.boolean(),
      reason: z.string().optional(),
      used: z.boolean(),
    })
  ),
  downgradeSkipped: z
    .object({
      reason: z.string(),
      existingConfidence: z.number(),
      attemptedConfidence: z.number(),
    })
    .optional(),
});
export type EnrichResult = z.infer<typeof enrichResponseSchema>;

export async function enrichProspect(prospectId: string): Promise<EnrichResult> {
  const response = await fetch(`/api/prospects/${prospectId}/enrich`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Enrich request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return enrichResponseSchema.parse(body);
}

// --- draft ---

// Mirrors `DraftProspectOutcome` in drafting.types.ts.
const draftResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    drafts: z.array(draftSchema),
    humanize: z.object({
      attempted: z.boolean(),
      outcome: z.enum(['humanized', 'deferred', 'failed']).optional(),
      reason: z.string().optional(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    flagged: z.enum(['missing_signal', 'no_llm_available', 'invalid_draft_output']),
    message: z.string(),
  }),
]);
export type DraftResult = z.infer<typeof draftResponseSchema>;

export async function draftProspect(prospectId: string): Promise<DraftResult> {
  const response = await fetch(`/api/prospects/${prospectId}/draft`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Draft request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return draftResponseSchema.parse(body);
}

// --- match ---

// Mirrors `MatchingOutcome` in matching.service.ts.
const matchResponseSchema = z.union([
  z.object({
    outcome: z.literal('applied'),
    prospectId: z.string(),
    suggestedServices: z.array(serviceSuggestionSchema),
  }),
  z.object({ outcome: z.literal('invalid_signal'), prospectId: z.string(), reason: z.string() }),
]);
export type MatchResult = z.infer<typeof matchResponseSchema>;

export async function matchProspect(prospectId: string): Promise<MatchResult> {
  const response = await fetch(`/api/prospects/${prospectId}/match`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Match request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return matchResponseSchema.parse(body);
}

// --- win ---

const winResponseSchema = z.union([
  z.object({ outcome: z.enum(['converted', 'already_converted']), clientId: z.string() }),
  z.object({ outcome: z.literal('blocked_do_not_contact') }),
]);
export type WinResult = z.infer<typeof winResponseSchema> | { outcome: 'not_found' };

// The route returns 404 (not 200) for a missing prospect - a typed
// `not_found` result rather than throwing, matching this hook's convention
// of surfacing every outcome (including "can't do this") to the caller.
export async function winProspect(prospectId: string): Promise<WinResult> {
  const response = await fetch(`/api/prospects/${prospectId}/win`, { method: 'POST' });
  if (response.status === 404) {
    return { outcome: 'not_found' };
  }
  if (!response.ok) {
    throw new Error(`Win request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return winResponseSchema.parse(body);
}

// --- seen ---

const seenResponseSchema = z.object({ id: z.string(), seen: z.boolean() });
export type SeenResult = z.infer<typeof seenResponseSchema>;

/**
 * Toggles the dashboard-only "seen" read marker (see the doc comment on
 * `Prospect.seen` in prisma/schema.prisma) - not part of the outreach
 * pipeline's own state, so unlike the other actions here this is meant to
 * be a fast, silent interaction: callers should update local state directly
 * rather than treating this like enrich/draft/match/win.
 */
export async function setProspectSeen(prospectId: string, seen: boolean): Promise<SeenResult> {
  const response = await fetch(`/api/prospects/${prospectId}/seen`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seen }),
  });
  if (!response.ok) {
    throw new Error(`Seen request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return seenResponseSchema.parse(body);
}

// --- bulk actions ---

// Shared shape every bulk route returns: one outcome per requested id,
// so the caller can report "N succeeded, M failed" instead of an
// all-or-nothing result. `clientId` is only ever populated by bulk win.
const bulkResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
  clientId: z.string().optional(),
});
export type BulkActionResult = z.infer<typeof bulkResultSchema>;

const bulkResponseSchema = z.object({ results: z.array(bulkResultSchema) });

async function postBulk(path: string, ids: string[]): Promise<BulkActionResult[]> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) {
    throw new Error(`Bulk request to ${path} failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return bulkResponseSchema.parse(body).results;
}

/** Bulk counterpart to `enrichProspect` - see `POST /api/prospects/bulk/enrich`. */
export async function bulkEnrichProspects(ids: string[]): Promise<BulkActionResult[]> {
  return postBulk('/api/prospects/bulk/enrich', ids);
}

/** Bulk counterpart to `draftProspect` - see `POST /api/prospects/bulk/draft`. */
export async function bulkDraftProspects(ids: string[]): Promise<BulkActionResult[]> {
  return postBulk('/api/prospects/bulk/draft', ids);
}

/** Bulk counterpart to `matchProspect` - see `POST /api/prospects/bulk/match`. */
export async function bulkMatchProspects(ids: string[]): Promise<BulkActionResult[]> {
  return postBulk('/api/prospects/bulk/match', ids);
}

/** Bulk counterpart to `winProspect` - see `POST /api/prospects/bulk/win`. */
export async function bulkWinProspects(ids: string[]): Promise<BulkActionResult[]> {
  return postBulk('/api/prospects/bulk/win', ids);
}

/** Bulk counterpart to `setProspectSeen` - see `PATCH /api/prospects/bulk/seen`. */
export async function bulkSetProspectsSeen(ids: string[], seen: boolean): Promise<BulkActionResult[]> {
  const response = await fetch('/api/prospects/bulk/seen', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, seen }),
  });
  if (!response.ok) {
    throw new Error(`Bulk seen request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return bulkResponseSchema.parse(body).results;
}

// --- detail ---

/** Full-detail fetch for the prospect detail dialog (every column plus drafts, not the list projection). */
export async function getProspectDetail(prospectId: string): Promise<Prospect> {
  const response = await fetch(`/api/prospects/${prospectId}`);
  if (!response.ok) {
    throw new Error(`Prospect detail request failed (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return prospectSchema.parse(body);
}
