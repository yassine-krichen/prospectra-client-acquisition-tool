// The only two accounts this app will ever have - there is no public
// registration. Deliberately hardcoded (not read from the database) so the
// login page's username picker never depends on a DB round-trip, and so it
// stays safe to import from a `'use client'` component (no `@/common/config/env`,
// `@/common/db/client`, etc. - see the repo root CLAUDE.md's client-bundle
// warning). The `User` rows themselves are provisioned by
// `app/api/cron/seed-users/route.ts`.
export const KNOWN_USERNAMES = ['Noel', 'EvilWithin'] as const;

export type KnownUsername = (typeof KNOWN_USERNAMES)[number];

export function isKnownUsername(value: string): value is KnownUsername {
  return (KNOWN_USERNAMES as readonly string[]).includes(value);
}
