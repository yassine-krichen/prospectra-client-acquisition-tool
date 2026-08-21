import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const updateManyMock = vi.fn();
vi.mock('@/common/db/client', () => ({
  prisma: { prospect: { updateMany: updateManyMock } },
}));

const { PATCH } = await import('./route');

function bulkSeenRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/bulk/seen', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/prospects/bulk/seen', () => {
  it('returns 400 when the body is missing ids or seen is not a boolean', async () => {
    const response = await PATCH(bulkSeenRequest({ ids: ['prospect-1'], seen: 'yes' }));

    expect(response.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is an empty array', async () => {
    const response = await PATCH(bulkSeenRequest({ ids: [], seen: true }));

    expect(response.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('updates each id sequentially and reports a per-id ok result', async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const response = await PATCH(bulkSeenRequest({ ids: ['prospect-1', 'missing-id'], seen: true }));

    expect(updateManyMock).toHaveBeenNthCalledWith(1, { where: { id: 'prospect-1' }, data: { seen: true } });
    expect(updateManyMock).toHaveBeenNthCalledWith(2, { where: { id: 'missing-id' }, data: { seen: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { id: 'prospect-1', ok: true },
        { id: 'missing-id', ok: false },
      ],
    });
  });
});
