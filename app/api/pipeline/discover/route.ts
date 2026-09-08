import { NextRequest } from 'next/server';

import { discoverRequestSchema, type DiscoveryStreamLine } from '@/features/discovery/discovery.types';
import { runDiscovery } from '@/features/discovery/discovery.service';

// Scraper-based sources (Yellow Pages, Indie Hackers) plus several API
// round-trips per run can take a while - same rationale as the discover
// cron's own maxDuration.
export const maxDuration = 60;

/**
 * Dashboard-triggered counterpart to `api/cron/discover` - runs the same
 * discovery pipeline on demand from a human clicking "Run discovery" in the
 * UI. Session-gated by `proxy.ts` (this route isn't under `api/cron/`, so
 * it's not exempt), so it deliberately does not check `x-cron-secret` - a
 * logged-in dashboard session is the authorization here, same as
 * `api/queue/approve`.
 *
 * Streams newline-delimited JSON (`DiscoveryStreamLine`) instead of a single
 * response body: each line is either a `progress` step, the final
 * `summary`, or an `error` - see discovery-trigger-form.tsx for the reader.
 * A plain `Response` (not `NextResponse.json`), since the body here is a
 * `ReadableStream`, not a value to serialize.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const fromBody = discoverRequestSchema.safeParse(body);
  const fromQuery = discoverRequestSchema.safeParse({
    category: request.nextUrl.searchParams.get('category'),
    geography: request.nextUrl.searchParams.get('geography'),
    branch: request.nextUrl.searchParams.get('branch') ?? undefined,
  });

  const parsed = fromBody.success ? fromBody : fromQuery;
  if (!parsed.success) {
    return Response.json({ error: 'category and geography are required.' }, { status: 400 });
  }

  const { category, geography, branch, sources } = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function writeLine(line: DiscoveryStreamLine): void {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }

      try {
        const summary = await runDiscovery({ category, geography }, branch, sources, (event) =>
          writeLine({ type: 'progress', ...event })
        );
        writeLine({ type: 'summary', summary });
      } catch (error) {
        writeLine({ type: 'error', message: error instanceof Error ? error.message : 'Discovery run failed.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
