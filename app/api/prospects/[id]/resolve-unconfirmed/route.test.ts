import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveUnconfirmedSendMock = vi.fn();
vi.mock('@/features/sending/resolve-unconfirmed-send.service', () => ({
  resolveUnconfirmedSend: resolveUnconfirmedSendMock,
}));

const { POST } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
});

function resolveRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1/resolve-unconfirmed', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/prospects/[id]/resolve-unconfirmed', () => {
  it('returns 404 for an unknown prospect', async () => {
    resolveUnconfirmedSendMock.mockResolvedValue({ outcome: 'not_found' });

    const response = await POST(resolveRequest({ outcome: 'delivered' }), routeParams('missing'));

    expect(response.status).toBe(404);
  });

  it('returns 400 for an invalid outcome without calling the service', async () => {
    const response = await POST(resolveRequest({ outcome: 'maybe' }), routeParams('prospect-1'));

    expect(response.status).toBe(400);
    expect(resolveUnconfirmedSendMock).not.toHaveBeenCalled();
  });

  it('returns 200 with nothing_to_resolve when there is nothing to resolve', async () => {
    resolveUnconfirmedSendMock.mockResolvedValue({ outcome: 'nothing_to_resolve' });

    const response = await POST(resolveRequest({ outcome: 'not_delivered' }), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'nothing_to_resolve' });
    expect(resolveUnconfirmedSendMock).toHaveBeenCalledWith('prospect-1', 'not_delivered');
  });
});
