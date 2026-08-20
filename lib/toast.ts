import { toast } from 'sonner';

// Thin, consistent wrapper over sonner so every page shows the same shape of
// toast rather than each action handler formatting its own. The specific
// problem this exists to fix: several API responses (discovery's per-source
// summary, enrichment's Hunter -> PDL -> pattern-guess chain) already carry
// a detailed, per-source reason for why something didn't happen — action
// handlers were discarding it and showing a generic one-liner instead. This
// module makes showing the real reason the path of least resistance.

export function toastSuccess(message: string, description?: string): void {
  toast.success(message, description ? { description } : undefined);
}

export function toastError(message: string, description?: string): void {
  toast.error(message, description ? { description } : undefined);
}

export function toastInfo(message: string, description?: string): void {
  toast.info(message, description ? { description } : undefined);
}

export interface SourceOutcome {
  source: string;
  ran: boolean;
  reason?: string;
  /** Present on discovery-style summaries (count found/enriched). */
  count?: number;
  /** Present on enrichment-chain summaries (whether this source's result was the one used). */
  used?: boolean;
}

// Human-readable label for a source's own machine name, e.g. "google_places"
// -> "Google Places". Falls back to the raw name for anything not listed
// here (e.g. a source added later) rather than guessing at a transform.
const SOURCE_LABELS: Record<string, string> = {
  google_places: 'Google Places',
  yellowpages: 'Yellow Pages',
  builtwith: 'BuiltWith',
  product_hunt: 'Product Hunt',
  crunchbase: 'Crunchbase',
  github: 'GitHub',
  indiehackers: 'Indie Hackers',
  hunter: 'Hunter.io',
  people_data_labs: 'People Data Labs',
  pattern_guess_mx: 'Pattern guess + MX check',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function describeSourceLine(outcome: SourceOutcome): string {
  const label = sourceLabel(outcome.source);
  if (!outcome.ran) return `${label}: skipped — ${outcome.reason ?? 'unavailable'}`;
  if (outcome.used === false) return `${label}: ran, not used (an earlier source already succeeded)`;
  if (outcome.count !== undefined) return `${label}: ${outcome.count} found`;
  return `${label}: ran`;
}

/**
 * Shows one toast whose description lists every source's exact outcome —
 * used for discovery runs and the enrichment chain, the two places this app
 * tries several sources in sequence and previously only surfaced a single
 * collapsed "it didn't work" message.
 */
export function toastSourceResults(title: string, sources: SourceOutcome[]): void {
  const description = sources.map(describeSourceLine).join('\n');
  const anySucceeded = sources.some((s) => s.ran && s.used !== false && (s.count === undefined || s.count > 0));
  if (anySucceeded) {
    toast.success(title, { description });
  } else {
    toast.warning(title, { description });
  }
}
