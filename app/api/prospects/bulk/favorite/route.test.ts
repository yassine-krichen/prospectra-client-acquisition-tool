import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const updateManyMock = vi.fn();
vi.mock('@/common/db/client', () => ({
  prisma: { prospect: { updateMany: updateManyMock } },
}));

const { PATCH } = await import('./route');

function bulkFavoriteRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/bulk/favorite', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/prospects/bulk/favorite', () => {
  it('returns 400 when the body is missing ids or favorite is not a boolean', async () => {
    const response = await PATCH(bulkFavoriteRequest({ ids: ['prospect-1'], favorite: 'yes' }));

    expect(response.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is an empty array', async () => {
    const response = await PATCH(bulkFavoriteRequest({ ids: [], favorite: true }));

    expect(response.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('updates each id sequentially and reports a per-id ok result', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const response = await PATCH(bulkFavoriteRequest({ ids: ['prospect-1', 'missing-id'], favorite: true }));

    expect(updateManyMock).toHaveBeenNthCalledWith(1, { where: { id: 'prospect-1' }, data: { favorite: true } });
    expect(updateManyMock).toHaveBeenNthCalledWith(2, { where: { id: 'missing-id' }, data: { favorite: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { id: 'prospect-1', ok: true },
        { id: 'missing-id', ok: false },
      ],
    });
  });
});
