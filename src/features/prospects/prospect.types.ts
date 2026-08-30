import { z } from 'zod';

import { serviceTypeSchema } from '@/features/pricing/service-type';

// Mirrors the enums/models defined in prisma/schema.prisma. Kept in sync by
// hand since Prisma's generated types describe persistence shape, not the
// validated shape of data crossing API boundaries.

export const industrySchema = z.enum(['local_service', 'saas', 'ecommerce', 'agency', 'other']);
export type Industry = z.infer<typeof industrySchema>;

export const companySizeSchema = z.enum(['1-10', '11-50', '51-200', '201+', 'unknown']);
export type CompanySize = z.infer<typeof companySizeSchema>;

export const prospectSourceSchema = z.enum([
  'google_places',
  'builtwith',
  'product_hunt',
  'crunchbase',
  'github',
  'indiehackers',
  'manual',
  'overpass',
  'yellowpages',
  'companies_house',
  'texas_comptroller',
]);
export type ProspectSource = z.infer<typeof prospectSourceSchema>;

export const signalTypeSchema = z.enum([
  'outdated_site',
  'no_https',
  'old_stack',
  'new_launch',
  'funding_event',
  'hiring_post',
  'no_website',
  'technical_debt',
  'recently_registered',
]);
export type SignalType = z.infer<typeof signalTypeSchema>;

export const signalStrengthSchema = z.enum(['weak', 'medium', 'strong']);
export type SignalStrength = z.infer<typeof signalStrengthSchema>;

export const projectFitSchema = z.enum(['landing_page', 'full_stack_app', 'backend_api', 'unclear']);
export type ProjectFit = z.infer<typeof projectFitSchema>;

export const estimatedBudgetSchema = z.enum(['low', 'mid', 'high', 'unknown']);
export type EstimatedBudget = z.infer<typeof estimatedBudgetSchema>;

export const prospectStatusSchema = z.enum([
  'new',
  'enriched',
  'drafted',
  'queued',
  'sent',
  'followup_1',
  'followup_2',
  'followup_3',
  'replied',
  'won',
  'dead',
  'unsubscribed',
]);
export type ProspectStatus = z.infer<typeof prospectStatusSchema>;

export const replySentimentSchema = z.enum(['positive', 'neutral', 'negative']);
export type ReplySentiment = z.infer<typeof replySentimentSchema>;

export const modelUsedSchema = z.enum(['gemini', 'groq', 'deepseek', 'claude-bridge']);
export type ModelUsed = z.infer<typeof modelUsedSchema>;

export const locationSchema = z.object({
  city: z.string().nullable(),
  country: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});
export type Location = z.infer<typeof locationSchema>;

export const signalSchema = z.object({
  type: signalTypeSchema,
  description: z.string(),
  evidence: z.string().nullable(),
  strength: signalStrengthSchema,
});
export type Signal = z.infer<typeof signalSchema>;

// Mirrors `ServiceSuggestion` in matching/service-matching-rules.ts.
// `source` is a literal today (only the rules engine produces suggestions
// in this scope), widening later if an LLM-suggestion overlay is added.
export const priceRangeCentsSchema = z.object({
  min: z.number().int(),
  max: z.number().int(),
});
export type PriceRangeCents = z.infer<typeof priceRangeCentsSchema>;

export const serviceSuggestionSchema = z.object({
  service: serviceTypeSchema,
  role: z.enum(['primary', 'cross_sell']),
  priceRangeCents: priceRangeCentsSchema.nullable(),
  requiresManualQuote: z.boolean(),
  reasoning: z.string(),
  source: z.literal('rules'),
});
export type ServiceSuggestion = z.infer<typeof serviceSuggestionSchema>;

// Mirrors `Prospect.lastDraftFailure` in prisma/schema.prisma - see that
// column's doc comment. `flagged` is deliberately a plain string (not
// `DraftProspectOutcome`'s narrower literal union) so an old persisted
// record from a since-retired flag value never fails validation.
export const draftFailureSchema = z.object({
  flagged: z.string(),
  message: z.string(),
  occurredAt: z.string(),
});
export type DraftFailure = z.infer<typeof draftFailureSchema>;

export const statusHistoryEntrySchema = z.object({
  status: z.string(),
  timestamp: z.coerce.date(),
});
export type StatusHistoryEntry = z.infer<typeof statusHistoryEntrySchema>;

export const draftSchema = z.object({
  id: z.string(),
  prospectId: z.string(),
  variant: z.number().int(),
  subject: z.string(),
  body: z.string(),
  humanizedBody: z.string().nullable(),
  modelUsed: modelUsedSchema,
  // Which copywriting framework (prompt-templates.ts's `FrameworkId`)
  // generated this variant. Nullable: rows created before this column
  // existed have no value on file.
  // Deliberately a plain string rather than a `FrameworkId` union: a strict union would fail validation on old rows once a framework is eventually retired from `ACTIVE_FRAMEWORKS`.
  framework: z.string().nullable(),
  generatedAt: z.coerce.date(),
  edited: z.boolean(),
  approved: z.boolean(),
});
export type Draft = z.infer<typeof draftSchema>;

// Mirrors `ProspectComment` in prisma/schema.prisma - see that model's doc
// comment. `authorNickname` is whoever wrote the comment, resolved
// server-side from the session cookie at creation time, never client-supplied.
export const prospectCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  authorNickname: z.string(),
  createdAt: z.coerce.date(),
});
export type ProspectComment = z.infer<typeof prospectCommentSchema>;

export const prospectSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  companyName: z.string(),
  domain: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  // Discovery-time contact fields (e.g. scraped straight off a yellowpages
  // listing) - see the doc comment on `Prospect.phone` in prisma/schema.prisma.
  // The one alternate contact channel for a prospect with no domain/website:
  // see `getRecommendation` in prospects-table.tsx.
  phone: z.string().nullable(),
  address: z.string().nullable(),
  industry: industrySchema,
  location: locationSchema,
  companySize: companySizeSchema,
  contactName: z.string().nullable(),
  contactTitle: z.string().nullable(),
  contactEmail: z.string().nullable(),
  emailVerified: z.boolean(),
  // 0-100 int, not the 0-1 float implied by the original spec. Chosen to
  // avoid float-precision surprises; not otherwise specified upstream.
  emailConfidence: z.number().int().min(0).max(100),
  linkedinUrl: z.string().nullable(),
  source: prospectSourceSchema,
  sourceUrl: z.string(),
  discoveredAt: z.coerce.date(),
  signal: signalSchema,
  projectFit: projectFitSchema,
  estimatedBudget: estimatedBudgetSchema,
  suggestedServices: z.array(serviceSuggestionSchema),
  priorityScore: z.number().int(),
  // How many independent discovery sources have found this business - see
  // the doc comment on `Prospect.corroboratingSourceCount` in
  // prisma/schema.prisma. Same precedent as `lastDraftFailure` below: a new
  // Prospect field exposed to the client, not omitted from the list
  // projection.
  corroboratingSourceCount: z.number().int(),
  status: prospectStatusSchema,
  statusHistory: z.array(statusHistoryEntrySchema),
  // Dashboard-only read marker - see the doc comment on `Prospect.seen` in
  // prisma/schema.prisma. Not part of the outreach pipeline's own state.
  seen: z.boolean(),
  // "Has a human opened this prospect's detail dialog" marker - see the doc
  // comment on `Prospect.lastOpenedAt` in prisma/schema.prisma. Both null
  // together (never opened) or both set together (most recent open).
  lastOpenedAt: z.coerce.date().nullable(),
  lastOpenedByNickname: z.string().nullable(),
  // Dead-letter tracking for the most recent failed `draftProspect` attempt
  // - see the doc comment on `Prospect.lastDraftFailure` in
  // prisma/schema.prisma. Null once the prospect has never failed drafting,
  // or once a later attempt succeeds.
  lastDraftFailure: draftFailureSchema.nullable(),
  drafts: z.array(draftSchema),
  // Newest first - see the doc comment on `Prospect.comments`/`ProspectComment`
  // in prisma/schema.prisma.
  comments: z.array(prospectCommentSchema),
  activeDraftId: z.string().nullable(),
  sentAt: z.coerce.date().nullable(),
  lastFollowupAt: z.coerce.date().nullable(),
  followupCount: z.number().int(),
  repliedAt: z.coerce.date().nullable(),
  replySentiment: replySentimentSchema.nullable(),
  doNotContact: z.boolean(),
  unsubscribedAt: z.coerce.date().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
});
export type Prospect = z.infer<typeof prospectSchema>;

// Narrower projection returned by the prospect list/dashboard view
// (`listProspects` in `prospects.repository.ts`). Excludes heavier fields
// the list UI doesn't render (drafts, statusHistory, notes, tags, contact
// details, follow-up/reply tracking) - a full prospect detail view can
// fetch the rest by id later. Keeping this explicit (rather than reusing
// the full `prospectSchema`) also means the list query only ever selects
// the columns it actually needs.
export const prospectListItemSchema = prospectSchema.omit({
  contactName: true,
  contactTitle: true,
  contactEmail: true,
  linkedinUrl: true,
  // `phone` is NOT omitted - `getRecommendation` in prospects-table.tsx
  // needs it to recommend "Call" over "Find website first" for a
  // domain-less prospect. `address` isn't needed by the list view.
  address: true,
  statusHistory: true,
  drafts: true,
  comments: true,
  activeDraftId: true,
  lastFollowupAt: true,
  followupCount: true,
  repliedAt: true,
  replySentiment: true,
  doNotContact: true,
  unsubscribedAt: true,
  notes: true,
  tags: true,
});
export type ProspectListItem = z.infer<typeof prospectListItemSchema>;
