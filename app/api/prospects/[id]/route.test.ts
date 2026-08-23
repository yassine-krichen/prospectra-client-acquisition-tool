import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const getProspectByIdMock = vi.fn();
const deleteProspectMock = vi.fn();
vi.mock('@/features/prospects/prospects.repository', () => ({
  getProspectById: getProspectByIdMock,
  deleteProspect: deleteProspectMock,
}));

const { GET, DELETE } = await import('./route');

function detailRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1');
}

function deleteRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1', { method: 'DELETE' });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/prospects/[id]', () => {
  it('returns 404 with an error message when no prospect exists with the given id', async () => {
    getProspectByIdMock.mockResolvedValue(null);

    const response = await GET(detailRequest(), routeParams('missing-id'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Prospect not found.' });
  });

  it('calls getProspectById with the id taken from the route params', async () => {
    getProspectByIdMock.mockResolvedValue({ id: 'prospect-1' });

    await GET(detailRequest(), routeParams('prospect-1'));

    expect(getProspectByIdMock).toHaveBeenCalledWith('prospect-1');
  });

  it('returns 200 with the full prospect on success', async () => {
    const prospect = { id: 'prospect-1', companyName: 'Acme', drafts: [] };
    getProspectByIdMock.mockResolvedValue(prospect);

    const response = await GET(detailRequest(), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(prospect);
  });
});

describe('DELETE /api/prospects/[id]', () => {
  it('returns 404 with an error message when no prospect exists with the given id', async () => {
    deleteProspectMock.mockResolvedValue({ outcome: 'not_found' });

    const response = await DELETE(deleteRequest(), routeParams('missing-id'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Prospect not found.' });
  });

  it('calls deleteProspect with the id taken from the route params', async () => {
    deleteProspectMock.mockResolvedValue({ outcome: 'deleted', id: 'prospect-1' });

    await DELETE(deleteRequest(), routeParams('prospect-1'));

    expect(deleteProspectMock).toHaveBeenCalledWith('prospect-1');
  });

  it('returns 200 with { id, deleted: true } on success', async () => {
    deleteProspectMock.mockResolvedValue({ outcome: 'deleted', id: 'prospect-1' });

    const response = await DELETE(deleteRequest(), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'prospect-1', deleted: true });
  });

  it('returns 200 (not 403) with outcome blocked_do_not_contact for a DNC prospect', async () => {
    deleteProspectMock.mockResolvedValue({ outcome: 'blocked_do_not_contact' });

    const response = await DELETE(deleteRequest(), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'blocked_do_not_contact' });
  });
});
