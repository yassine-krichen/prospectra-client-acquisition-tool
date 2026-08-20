// Generates standard corporate email address patterns from a contact name
// and domain - no API key needed. This is the last-resort fallback in
// enrichment.service.ts's chain: a guess, not a verified email, so callers
// must pair it with a plausibility check (see smtp-verify.ts) and score it
// with a conservatively low confidence.

const COMBINING_DIACRITICAL_MARKS_PATTERN = /[̀-ͯ]/g;

function normalizeNamePart(part: string): string {
  return part
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_DIACRITICAL_MARKS_PATTERN, '') // strip diacritics (é -> e)
    .replace(/[^a-z0-9]/g, '');
}

interface NameParts {
  first: string;
  last: string;
}

function splitContactName(contactName: string): NameParts | null {
  const parts = contactName
    .trim()
    .split(/\s+/)
    .map(normalizeNamePart)
    .filter((part) => part.length > 0);

  if (parts.length === 0) return null;
  if (parts.length === 1) return { first: parts[0], last: '' };

  return { first: parts[0], last: parts[parts.length - 1] };
}

/**
 * Generates the standard set of guessed email addresses for a contact at a
 * domain, ordered most- to least-likely. Falls back to generic role
 * addresses (hello@, contact@, info@) when no usable contact name is given.
 * Never throws; returns an empty array only if `domain` is empty.
 */
export function generateEmailGuesses(contactName: string | null, domain: string): string[] {
  const normalizedDomain = domain.trim().toLowerCase();
  if (!normalizedDomain) return [];

  const genericGuesses = [`hello@${normalizedDomain}`, `contact@${normalizedDomain}`, `info@${normalizedDomain}`];

  const nameParts = contactName ? splitContactName(contactName) : null;
  if (!nameParts || !nameParts.first) return genericGuesses;

  const { first, last } = nameParts;
  if (!last) {
    return [`${first}@${normalizedDomain}`, ...genericGuesses];
  }

  return [
    `${first}@${normalizedDomain}`,
    `${first}.${last}@${normalizedDomain}`,
    `${first}${last}@${normalizedDomain}`,
    `${first[0]}${last}@${normalizedDomain}`,
    `${first[0]}.${last}@${normalizedDomain}`,
    `${first}${last[0]}@${normalizedDomain}`,
    ...genericGuesses,
  ];
}
