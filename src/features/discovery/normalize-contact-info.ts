// Phone/address/company-name normalization shared by discovery's
// dedupe/persist logic (discovery.service.ts) - these are secondary match
// keys for prospects with no domain, mirroring normalize-domain.ts's role for
// domain matching.

/**
 * Strips a phone number down to digits only, dropping a leading US country
 * code ("1") when the remaining digits form a valid 11-digit US number.
 * Returns `null` for null/empty input. Deliberately simple - no
 * `libphonenumber`-grade parsing, no international number support beyond
 * this one US-specific normalization.
 */
export function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }

  return digits;
}

// Common street-suffix abbreviations, applied after lowercasing/whitespace
// collapse so "123 Main St" and "123 Main Street" compare equal.
const STREET_SUFFIX_ALIASES: Record<string, string> = {
  st: 'street',
  ave: 'avenue',
  rd: 'road',
  blvd: 'boulevard',
  dr: 'drive',
  ln: 'lane',
};

/**
 * Normalizes an address for equality comparison: lowercases, trims, collapses
 * whitespace, and expands common street-suffix abbreviations (st -> street,
 * ave -> avenue, etc). Returns `null` for null/empty input.
 *
 * This is a heuristic for cheap duplicate detection, not authoritative
 * address matching - it does not handle unit-number formatting (e.g. "Apt 2"
 * vs "#2") or directional-prefix differences (e.g. "N Main St" vs
 * "North Main Street"). False negatives (missed duplicates) are expected and
 * acceptable; it should not produce false positives.
 */
export function normalizeAddress(address: string | null): string | null {
  if (!address) return null;

  const collapsed = address.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!collapsed) return null;

  const expanded = collapsed
    .split(' ')
    .map((word) => {
      const bareWord = word.replace(/[.,]/g, '');
      return STREET_SUFFIX_ALIASES[bareWord] ?? word.replace(/[.,]/g, '');
    })
    .join(' ');

  return expanded;
}

// Legal-entity suffixes stripped from the end of a normalized company name -
// only when they're the LAST word, so a business literally named e.g. "Corp
// Consulting" isn't corrupted into "consulting".
const LEGAL_SUFFIXES = new Set([
  'llc',
  'inc',
  'incorporated',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'llp',
]);

/**
 * Normalizes a company name for equality comparison: lowercases, trims,
 * collapses whitespace, strips punctuation, then strips exactly one trailing
 * legal-suffix token (llc, inc, ltd, etc - see `LEGAL_SUFFIXES`) when it's the
 * last word.
 *
 * Like `normalizeAddress`, this is exact-match-after-normalization, not
 * fuzzy/Levenshtein matching - a real fuzzy-matching system is bigger,
 * separate, explicitly deferred work (see docs/discovery-engine-roadmap.md).
 * Known false negative: "Joe's Roofing" vs "Joe Roofing" (missing
 * possessive) will NOT normalize to the same string. False negatives (missed
 * duplicates) are expected and acceptable; it should not produce false
 * positives.
 */
export function normalizeCompanyName(name: string): string {
  const collapsed = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const stripped = collapsed.replace(/[.,]/g, '');
  if (!stripped) return stripped;

  const words = stripped.split(' ');
  const lastWord = words[words.length - 1];
  if (words.length > 1 && LEGAL_SUFFIXES.has(lastWord)) {
    words.pop();
  }

  return words.join(' ');
}
