import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { verifyResendWebhookSignature } from '@/features/followups/verify-resend-signature';
import { processInboundReply } from '@/features/followups/reply-detection.service';

// The one intentionally-unauthenticated-by-session route in this app: it
// receives POSTs from Resend's own servers, not from the dashboard's
// logged-in user, so it cannot sit behind the session-cookie gate (see
// proxy.ts's matcher, which explicitly excludes this exact path). Because it
// can't use session auth, it MUST verify Resend's webhook signature instead
// — an unverified version of this route would let anyone on the internet
// forge a "prospect replied with unsubscribe intent" event and have this
// app permanently flag any prospect's contactEmail as doNotContact. Fail
// closed at every step: invalid/missing signature, or `data.from` present
// but unparseable, both reject before `processInboundReply` is ever called.

// Resend's inbound/received-email webhook payload — a superset of fields is
// documented; only what this route actually needs is validated here. `from`
// commonly arrives as either a bare address or an RFC 5322 `"Name" <addr>`
// display form, so it's extracted with a regex rather than assumed to be a
// bare email string.
const resendWebhookEventSchema = z.object({
  type: z.string(),
  data: z.object({
    from: z.string().min(1),
    subject: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
  }),
});

// Only these event types represent an inbound reply worth processing.
// Anything else (delivery/open/click/bounce events Resend also sends to the
// same webhook endpoint) is acknowledged with 200 and otherwise ignored —
// not every event this endpoint receives is an attack or an error, most of
// them just aren't relevant to reply detection.
const REPLY_EVENT_TYPES = new Set(['email.received', 'inbound.email.received']);

const EMAIL_IN_ANGLE_BRACKETS = /<([^<>]+)>/;

function extractEmailAddress(fromField: string): string | null {
  const angleMatch = fromField.match(EMAIL_IN_ANGLE_BRACKETS);
  const candidate = (angleMatch ? angleMatch[1] : fromField).trim();
  return z.string().email().safeParse(candidate).success ? candidate : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();

  const isVerified = await verifyResendWebhookSignature(rawBody, {
    svixId: request.headers.get('svix-id'),
    svixTimestamp: request.headers.get('svix-timestamp'),
    svixSignature: request.headers.get('svix-signature'),
  });

  if (!isVerified) {
    return NextResponse.json({ error: 'Invalid or missing webhook signature.' }, { status: 401 });
  }

  const json: unknown = (() => {
    try {
      return JSON.parse(rawBody);
    } catch {
      return null;
    }
  })();
  const parsedEvent = resendWebhookEventSchema.safeParse(json);
  if (!parsedEvent.success) {
    return NextResponse.json({ error: 'Malformed webhook payload.' }, { status: 400 });
  }

  const event = parsedEvent.data;
  if (!REPLY_EVENT_TYPES.has(event.type)) {
    return NextResponse.json({ ignored: true, type: event.type });
  }

  const fromEmail = extractEmailAddress(event.data.from);
  if (!fromEmail) {
    return NextResponse.json({ error: 'Could not parse a sender email address.' }, { status: 400 });
  }

  const result = await processInboundReply({
    fromEmail,
    subject: event.data.subject ?? null,
    text: event.data.text ?? null,
  });

  return NextResponse.json({ result });
}
