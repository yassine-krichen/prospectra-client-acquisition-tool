import { env } from '@/common/config/env';
import { sha256Hex, timingSafeEqual } from '@/common/auth/session';

// Shared by every `app/api/cron/*/route.ts` handler - previously each route
// duplicated its own `isAuthorized`. Extracted once two call schemes existed
// (see below) rather than duplicating both across four more files.

// Fail closed: hash both sides to a fixed-length digest before the
// constant-time compare, since `timingSafeEqual`'s early length check would
// otherwise leak the secret's length for variable-length inputs.
async function matchesCronSecret(provided: string | null): Promise<boolean> {
  if (!provided) return false;
  const [providedHash, expectedHash] = await Promise.all([sha256Hex(provided), sha256Hex(env.CRON_SECRET)]);
  return timingSafeEqual(providedHash, expectedHash);
}

// Manual/ad-hoc triggering (curl, scripts): `x-cron-secret: <CRON_SECRET>`.
export async function isAuthorizedByCronHeader(request: Request): Promise<boolean> {
  return matchesCronSecret(request.headers.get('x-cron-secret'));
}

// Vercel's own Cron Jobs feature only ever issues GET requests and
// auto-attaches `Authorization: Bearer <value>` using whatever the
// project's `CRON_SECRET` env var holds - this is Vercel's convention, not
// this app's `x-cron-secret` header, so routes that Vercel Cron calls
// directly (app/api/cron/daily, the discover route's GET handler) need to
// check this scheme instead.
// https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
export async function isAuthorizedByCronBearer(request: Request): Promise<boolean> {
  const header = request.headers.get('authorization');
  const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  return matchesCronSecret(provided);
}
