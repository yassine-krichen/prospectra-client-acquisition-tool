import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const convertProspectToClientMock = vi.fn();
vi.mock('@/features/prospects/convert-to-client.service', () => ({
  convertProspectToClient: convertProspectToClientMock,
}));

const { POST } = await import('./route');

function winRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1/win', { method: 'POST' });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/prospects/[id]/win', () => {
  it('returns 404 with an error message when no prospect exists with the given id', async () => {
    convertProspectToClientMock.mockResolvedValue({ outcome: 'not_found' });

    const response = await POST(winRequest(), routeParams('missing-id'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Prospect not found.' });
  });

  it('calls convertProspectToClient with the id taken from the route params', async () => {
    convertProspectToClientMock.mockResolvedValue({ outcome: 'converted', clientId: 'client-1' });

    await POST(winRequest(), routeParams('prospect-1'));

    expect(convertProspectToClientMock).toHaveBeenCalledWith('prospect-1');
  });

  it('returns 200 with outcome converted and the new clientId', async () => {
    convertProspectToClientMock.mockResolvedValue({ outcome: 'converted', clientId: 'client-1' });

    const response = await POST(winRequest(), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'converted', clientId: 'client-1' });
  });

  it('returns 200 with outcome already_converted and the existing clientId', async () => {
    convertProspectToClientMock.mockResolvedValue({ outcome: 'already_converted', clientId: 'client-existing' });

    const response = await POST(winRequest(), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'already_converted', clientId: 'client-existing' });
  });

  it('returns 200 (not 403) with outcome blocked_do_not_contact, matching the per-item-outcome convention', async () => {
    convertProspectToClientMock.mockResolvedValue({ outcome: 'blocked_do_not_contact' });

    const response = await POST(winRequest(), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'blocked_do_not_contact' });
  });
});
