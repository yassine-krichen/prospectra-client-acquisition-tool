import { cookies } from 'next/headers';

import { SESSION_COOKIE_NAME, verifySessionToken } from '@/common/auth/session';
import { DashboardNav } from '@/features/navigation/dashboard-nav';

// Server component - reads the session cookie directly (proxy.ts already
// guarantees a valid one reaches here for every dashboard route) to pass
// the signed-in nickname down to the client-side nav for display. Safe to
// import session.ts (and transitively env.ts) here specifically because
// this file is never a 'use client' component itself - see the repo root
// CLAUDE.md's client-bundle warning, which is about files a client
// component imports, not server components like this one.
export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);

  return (
    <div className="bg-muted/30 flex min-h-screen">
      <DashboardNav nickname={session?.nickname ?? null} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
