import { ProspectStatus as PrismaProspectStatus } from '@/lib/generated/prisma/client';
import { prisma } from '@/common/db/client';
import { generateEmailGuesses } from '@/features/enrichment/pattern-guess';
import { domainAcceptsEmail } from '@/features/enrichment/smtp-verify';
import { runHunterEnrichment } from '@/features/enrichment/hunter.source';
import { runPeopleDataLabsEnrichment } from '@/features/enrichment/peopledatalabs.source';
import { applyServiceMatching } from '@/features/matching/matching.service';
import type {
  EnrichedContact,
  EnrichmentInput,
  EnrichmentResult,
  EnrichmentSourceSummary,
  EnrichProspectResult,
} from '@/features/enrichment/enrichment.types';

// A guessed-and-MX-checked email was never actually confirmed to exist —
// only that its domain can theoretically receive mail — so it's scored well
// below anything Hunter or PDL return (their lowest realistic confidence is
// still well above this). This is the least confident this app's
// `emailConfidence` scale ever goes for a non-empty email.
const PATTERN_GUESS_CONFIDENCE = 15;

const PROSPECT_SELECT = {
  id: true,
  companyName: true,
  domain: true,
  contactName: true,
  contactTitle: true,
  contactEmail: true,
  emailVerified: true,
  emailConfidence: true,
  linkedinUrl: true,
  status: true,
  updatedAt: true,
  statusHistory: true,
} as const;

interface ProspectRow {
  id: string;
  companyName: string;
  domain: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  emailVerified: boolean;
  emailConfidence: number;
  linkedinUrl: string | null;
  status: PrismaProspectStatus;
  updatedAt: Date;
  statusHistory: unknown;
}

function toView(row: ProspectRow) {
  return {
    id: row.id,
    companyName: row.companyName,
    domain: row.domain,
    contactName: row.contactName,
    contactTitle: row.contactTitle,
    contactEmail: row.contactEmail,
    emailVerified: row.emailVerified,
    emailConfidence: row.emailConfidence,
    linkedinUrl: row.linkedinUrl,
    status: row.status,
    updatedAt: row.updatedAt,
  };
}

/**
 * Last-resort enrichment step: generates standard email patterns for the
 * domain and picks the first one whose domain has an MX record. Doesn't
 * verify the mailbox itself exists (see smtp-verify.ts's doc comment for
 * why), so it's the lowest-confidence result in the chain.
 */
async function guessAndCheckEmail(input: EnrichmentInput): Promise<EnrichmentResult> {
  const guesses = generateEmailGuesses(input.contactName, input.domain);
  if (guesses.length === 0) {
    return { ok: false, reason: 'source unavailable: no domain to generate email guesses against' };
  }

  if (!(await domainAcceptsEmail(input.domain))) {
    return { ok: false, reason: `source unavailable: ${input.domain} has no MX record` };
  }

  return {
    ok: true,
    contact: {
      contactName: input.contactName,
      contactTitle: null,
      contactEmail: guesses[0],
      emailVerified: false,
      emailConfidence: PATTERN_GUESS_CONFIDENCE,
      linkedinUrl: null,
    },
  };
}

/**
 * Runs the Branch C enrichment fallback chain — Hunter -> People Data Labs
 * -> pattern-guess+MX-check — stopping at the first source that returns a
 * usable contact. Never throws: each source degrades to a typed
 * `ok:false`, and this function reports every attempted source's outcome in
 * the returned `sources` summary regardless of which one (if any) supplied
 * the final contact.
 */
async function runEnrichmentChain(
  input: EnrichmentInput
): Promise<{ contact: EnrichedContact | null; sources: EnrichmentSourceSummary[] }> {
  const sources: EnrichmentSourceSummary[] = [];

  const chain: Array<{ name: string; run: () => Promise<EnrichmentResult> }> = [
    { name: 'hunter', run: () => runHunterEnrichment(input) },
    { name: 'people_data_labs', run: () => runPeopleDataLabsEnrichment(input) },
    { name: 'pattern_guess_mx', run: () => guessAndCheckEmail(input) },
  ];

  for (const { name, run } of chain) {
    const result = await run();

    if (result.ok) {
      sources.push({ source: name, ran: true, used: true });
      // Any source after this one in the chain never runs — recorded here
      // (rather than as `ran: false` entries) since it's a deliberate
      // "already have a usable result" skip, not an availability failure.
      return { contact: result.contact, sources };
    }

    sources.push({ source: name, ran: false, reason: result.reason, used: false });
  }

  return { contact: null, sources };
}

/**
 * Enriches a single prospect's contact info: loads it, runs the fallback
 * chain, persists whichever result was found, and returns the updated
 * prospect. Returns `null` if no prospect exists with `prospectId` — the
 * caller (the `/enrich` route) maps that to a 404.
 */
export async function enrichProspect(prospectId: string): Promise<EnrichProspectResult | null> {
  const existing = (await prisma.prospect.findUnique({
    where: { id: prospectId },
    select: PROSPECT_SELECT,
  })) as ProspectRow | null;

  if (!existing) return null;

  if (!existing.domain) {
    const reason = 'source unavailable: prospect has no domain to enrich against';
    return {
      prospect: toView(existing),
      sources: [
        { source: 'hunter', ran: false, reason, used: false },
        { source: 'people_data_labs', ran: false, reason, used: false },
        { source: 'pattern_guess_mx', ran: false, reason, used: false },
      ],
    };
  }

  const { contact, sources } = await runEnrichmentChain({
    domain: existing.domain,
    companyName: existing.companyName,
    contactName: existing.contactName,
  });

  if (!contact) {
    return { prospect: toView(existing), sources };
  }

  // Monotonicity guard: a prospect that already has a verified/higher-
  // confidence contact (e.g. a Hunter result) must never be silently
  // overwritten by a worse one from a later enrichment attempt (e.g. Hunter's
  // quota is now exhausted and the chain fell to a pattern-guess). An
  // existing contact only counts as "already have something to protect" once
  // there's actually an email on file.
  if (
    existing.contactEmail &&
    (contact.emailConfidence < existing.emailConfidence ||
      (existing.emailVerified === true && contact.emailVerified === false))
  ) {
    return {
      prospect: toView(existing),
      sources,
      downgradeSkipped: {
        reason: 'kept existing higher-confidence contact, new attempt was lower confidence',
        existingConfidence: existing.emailConfidence,
        attemptedConfidence: contact.emailConfidence,
      },
    };
  }

  // Every enrichment source in this phase discovers/confirms a contact —
  // 'new' is the only status this moves forward from, so a prospect that's
  // already progressed further (drafted, sent, etc) keeps its status as-is.
  const nextStatus =
    existing.status === PrismaProspectStatus.new ? PrismaProspectStatus.enriched : existing.status;
  const statusHistory = Array.isArray(existing.statusHistory) ? existing.statusHistory : [];
  const nextStatusHistory =
    nextStatus !== existing.status
      ? [...statusHistory, { status: nextStatus, timestamp: new Date().toISOString() }]
      : statusHistory;

  const updated = (await prisma.prospect.update({
    where: { id: prospectId },
    data: {
      contactName: contact.contactName ?? existing.contactName,
      contactTitle: contact.contactTitle ?? existing.contactTitle,
      contactEmail: contact.contactEmail,
      emailVerified: contact.emailVerified,
      emailConfidence: contact.emailConfidence,
      linkedinUrl: contact.linkedinUrl ?? existing.linkedinUrl,
      status: nextStatus,
      statusHistory: nextStatusHistory,
    },
    select: PROSPECT_SELECT,
  })) as ProspectRow;

  // Company size/industry confidence may have shifted now that a contact was
  // found — recompute service suggestions against the freshly enriched
  // prospect rather than leaving discovery-time suggestions stale.
  await applyServiceMatching(prospectId);

  return { prospect: toView(updated), sources };
}
