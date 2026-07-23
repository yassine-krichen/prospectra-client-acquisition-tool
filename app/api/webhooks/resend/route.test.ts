import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Orchestration test for the route itself: signature verification and reply
// processing each have their own dedicated suites
// (verify-resend-signature.test.ts, reply-detection.service.test.ts), so both
// are mocked here — this only exercises the route's own auth gate,
// event-type filtering, and from-address extraction/wiring.
const verifyResendWebhookSignatureMock = vi.fn();
vi.mock('@/features/followups/verify-resend-signature', () => ({
  verifyResendWebhookSignature: verifyResendWebhookSignatureMock,
}));

const processInboundReplyMock = vi.fn();
vi.mock('@/features/followups/reply-detection.service', () => ({
  processInboundReply: processInboundReplyMock,
}));

const { POST } = await import('./route');

function webhookRequest(rawBody: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/resend', {
    method: 'POST',
    body: rawBody,
    headers,
  });
}

const VALID_HEADERS = {
  'svix-id': 'msg_test123',
  'svix-timestamp': '1700000000',
  'svix-signature': 'v1,some-signature==',
};

function inboundReplyEventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'email.received',
    data: { from: 'prospect@example.com', subject: 'Re: outreach', text: 'sounds good', ...overrides },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyResendWebhookSignatureMock.mockResolvedValue(true);
  processInboundReplyMock.mockResolvedValue({ outcome: 'no_match' });
});

describe('POST /api/webhooks/resend signature verification', () => {
  it('rejects with 401 and never calls processInboundReply when the signature does not verify', async () => {
    verifyResendWebhookSignatureMock.mockResolvedValue(false);

    const response = await POST(webhookRequest(inboundReplyEventBody(), VALID_HEADERS));

    expect(response.status).toBe(401);
    expect(processInboundReplyMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the svix headers are missing entirely, never calling processInboundReply', async () => {
    verifyResendWebhookSignatureMock.mockResolvedValue(false);

    const response = await POST(webhookRequest(inboundReplyEventBody(), {}));

    expect(response.status).toBe(401);
    expect(processInboundReplyMock).not.toHaveBeenCalled();
  });

  it('passes the exact raw body text (not a re-serialized/parsed version) to the signature verifier', async () => {
    const rawBody = inboundReplyEventBody();

    await POST(webhookRequest(rawBody, VALID_HEADERS));

    expect(verifyResendWebhookSignatureMock).toHaveBeenCalledWith(rawBody, {
      svixId: VALID_HEADERS['svix-id'],
      svixTimestamp: VALID_HEADERS['svix-timestamp'],
      svixSignature: VALID_HEADERS['svix-signature'],
    });
  });
});

describe('POST /api/webhooks/resend payload validation', () => {
  it('returns 400 and never calls processInboundReply for a body that is not valid JSON, even with a verified signature', async () => {
    const response = await POST(webhookRequest('not valid json', VALID_HEADERS));

    expect(response.status).toBe(400);
    expect(processInboundReplyMock).not.toHaveBeenCalled();
  });

  it('returns 400 and never calls processInboundReply when the payload is missing the required "data.from" field', async () => {
    const response = await POST(
      webhookRequest(JSON.stringify({ type: 'email.received', data: {} }), VALID_HEADERS)
    );

    expect(response.status).toBe(400);
    expect(processInboundReplyMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the from address cannot be parsed as a valid email', async () => {
    const response = await POST(
      webhookRequest(
        JSON.stringify({ type: 'email.received', data: { from: 'not-an-email-address', subject: null, text: null } }),
        VALID_HEADERS
      )
    );

    expect(response.status).toBe(400);
    expect(processInboundReplyMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/resend irrelevant event types', () => {
  it('returns 200 with ignored:true and never calls processInboundReply for a delivery-status event type', async () => {
    const response = await POST(
      webhookRequest(JSON.stringify({ type: 'email.delivered', data: { from: 'prospect@example.com' } }), VALID_HEADERS)
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ignored: true, type: 'email.delivered' });
    expect(processInboundReplyMock).not.toHaveBeenCalled();
  });

  it('returns 200 with ignored:true for a bounce event, still requiring a verified signature first', async () => {
    const response = await POST(
      webhookRequest(JSON.stringify({ type: 'email.bounced', data: { from: 'prospect@example.com' } }), VALID_HEADERS)
    );

    expect(response.status).toBe(200);
    expect(processInboundReplyMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/resend relevant reply events', () => {
  it('extracts a bare email address and calls processInboundReply with the extracted fromEmail, subject, and text', async () => {
    processInboundReplyMock.mockResolvedValue({ outcome: 'matched', prospectId: 'prospect-1', sentiment: 'neutral' });

    const response = await POST(webhookRequest(inboundReplyEventBody(), VALID_HEADERS));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(processInboundReplyMock).toHaveBeenCalledWith({
      fromEmail: 'prospect@example.com',
      subject: 'Re: outreach',
      text: 'sounds good',
    });
    expect(body).toEqual({ result: { outcome: 'matched', prospectId: 'prospect-1', sentiment: 'neutral' } });
  });

  it('extracts the email address out of an RFC 5322 "Name <email>" display-form from field', async () => {
    const rawBody = JSON.stringify({
      type: 'inbound.email.received',
      data: { from: '"Jane Prospect" <prospect@example.com>', subject: null, text: 'ok' },
    });

    await POST(webhookRequest(rawBody, VALID_HEADERS));

    expect(processInboundReplyMock).toHaveBeenCalledWith({
      fromEmail: 'prospect@example.com',
      subject: null,
      text: 'ok',
    });
  });

  it('treats a missing subject/text as null rather than omitting the fields', async () => {
    const rawBody = JSON.stringify({ type: 'email.received', data: { from: 'prospect@example.com' } });

    await POST(webhookRequest(rawBody, VALID_HEADERS));

    expect(processInboundReplyMock).toHaveBeenCalledWith({
      fromEmail: 'prospect@example.com',
      subject: null,
      text: null,
    });
  });

  it('recognizes both accepted reply event type spellings ("email.received" and "inbound.email.received")', async () => {
    await POST(webhookRequest(JSON.stringify({ type: 'inbound.email.received', data: { from: 'a@b.com' } }), VALID_HEADERS));

    expect(processInboundReplyMock).toHaveBeenCalledTimes(1);
  });
});
