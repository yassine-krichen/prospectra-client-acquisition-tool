import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the classification of failures into definitelyNotSent vs ambiguous is
// under test: callers that must never double-send (send-queue, follow-ups,
// retention) trust this flag, so a 5xx or timeout being misread as a definite
// rejection would let a possibly-delivered email go out twice.
const { envMock } = vi.hoisted(() => ({
  envMock: { RESEND_API_KEY: 're_test' as string | undefined, SENDING_DOMAIN: 'example.com' as string | undefined },
}));
vi.mock('@/common/config/env', () => ({ env: envMock }));

const fetchMock = vi.fn();

const { sendEmail } = await import('./resend.client');

const INPUT = { to: 'jane@acme.com', subject: 'Hi', body: 'Body' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  envMock.RESEND_API_KEY = 're_test';
  envMock.SENDING_DOMAIN = 'example.com';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendEmail definitelyNotSent classification', () => {
  it('is true and never calls fetch when RESEND_API_KEY is missing', async () => {
    envMock.RESEND_API_KEY = undefined;

    const result = await sendEmail(INPUT);

    expect(result).toMatchObject({ ok: false, definitelyNotSent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is true and never calls fetch when SENDING_DOMAIN is missing', async () => {
    envMock.SENDING_DOMAIN = undefined;

    const result = await sendEmail(INPUT);

    expect(result).toMatchObject({ ok: false, definitelyNotSent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 422, 429])('is true for a %i rejection', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { message: 'rejected' }));

    const result = await sendEmail(INPUT);

    expect(result).toMatchObject({ ok: false, definitelyNotSent: true });
  });

  it.each([408, 500, 503])('is not true for a %i response (the email may have been sent)', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { message: 'oops' }));

    const result = await sendEmail(INPUT);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('definitelyNotSent', true);
  });

  it('is not true when fetch throws (timeout / connection reset after the request may have landed)', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const result = await sendEmail(INPUT);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('definitelyNotSent', true);
  });

  it.each([
    ['a body that is not JSON', new Response('<html>ok</html>', { status: 200 })],
    ['a JSON body without an id', jsonResponse(200, { unexpected: true })],
  ])('is not true for a 2xx with %s', async (_label, response) => {
    fetchMock.mockResolvedValue(response);

    const result = await sendEmail(INPUT);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('definitelyNotSent', true);
  });

  it('returns ok with the message id for a well-formed 2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'msg-1' }));

    expect(await sendEmail(INPUT)).toEqual({ ok: true, id: 'msg-1' });
  });
});
