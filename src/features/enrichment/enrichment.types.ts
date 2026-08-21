// Shared shapes for Branch C contact enrichment, mirroring the
// discovery.types.ts pattern: every enrichment source returns a typed
// `ok:false` instead of throwing when it's unavailable (missing key,
// exhausted quota, network error, non-2xx, shape mismatch), so one source
// failing never crashes the fallback chain in enrichment.service.ts.

export interface EnrichmentInput {
  domain: string;
  companyName: string;
  /** Known contact name, if any prior source already found one. */
  contactName: string | null;
}

export interface EnrichedContact {
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string;
  emailVerified: boolean;
  /** 0-100. See each source's own doc comment for how it's derived. */
  emailConfidence: number;
  linkedinUrl: string | null;
}

export interface SourceUnavailable {
  ok: false;
  /** Human-readable reason, e.g. "source unavailable: X_API_KEY not configured". */
  reason: string;
}

export interface EnrichmentSuccess {
  ok: true;
  contact: EnrichedContact;
}

export type EnrichmentResult = EnrichmentSuccess | SourceUnavailable;

export interface EnrichmentSourceSummary {
  source: string;
  ran: boolean;
  reason?: string;
  /** True for the one source in the fallback chain whose result was used. */
  used: boolean;
}

export interface EnrichedProspectView {
  id: string;
  companyName: string;
  domain: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  emailVerified: boolean;
  emailConfidence: number;
  linkedinUrl: string | null;
  status: string;
  updatedAt: Date;
}

export interface EnrichProspectResult {
  prospect: EnrichedProspectView;
  sources: EnrichmentSourceSummary[];
  /**
   * Set when the enrichment chain found a usable contact but it was a
   * downgrade from what the prospect already had (see
   * `enrichment.service.ts`'s monotonicity guard) - the existing,
   * higher-confidence contact was kept instead of being overwritten.
   */
  downgradeSkipped?: {
    reason: string;
    existingConfidence: number;
    attemptedConfidence: number;
  };
}
