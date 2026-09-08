import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const updateManyMock = vi.fn();
vi.mock('@/common/db/client', () => ({
  prisma: { prospect: { updateMany: updateManyMock } },
}));

const { PATCH } = await import('./route');

function favoriteRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1/favorite', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('PATCH /api/prospects/[id]/favorite', () => {
  it('returns 400 when the body is missing or "favorite" is not a boolean', async () => {
    const response = await PATCH(favoriteRequest({ favorite: 'yes' }), routeParams('prospect-1'));

    expect(response.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('returns 404 when no prospect exists with the given id', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const response = await PATCH(favoriteRequest({ favorite: true }), routeParams('missing-id'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Prospect not found.' });
  });

  it('updates the favorite flag by id and returns 200 with the new value', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(favoriteRequest({ favorite: true }), routeParams('prospect-1'));

    expect(updateManyMock).toHaveBeenCalledWith({ where: { id: 'prospect-1' }, data: { favorite: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'prospect-1', favorite: true });
  });

  it('can set favorite back to false', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(favoriteRequest({ favorite: false }), routeParams('prospect-1'));

    expect(await response.json()).toEqual({ id: 'prospect-1', favorite: false });
  });
});
