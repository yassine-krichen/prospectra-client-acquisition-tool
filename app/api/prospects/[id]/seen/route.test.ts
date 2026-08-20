import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const updateManyMock = vi.fn();
vi.mock('@/common/db/client', () => ({
  prisma: { prospect: { updateMany: updateManyMock } },
}));

const { PATCH } = await import('./route');

function seenRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1/seen', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('PATCH /api/prospects/[id]/seen', () => {
  it('returns 400 when the body is missing or "seen" is not a boolean', async () => {
    const response = await PATCH(seenRequest({ seen: 'yes' }), routeParams('prospect-1'));

    expect(response.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('returns 404 when no prospect exists with the given id', async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    const response = await PATCH(seenRequest({ seen: true }), routeParams('missing-id'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Prospect not found.' });
  });

  it('updates the seen flag by id and returns 200 with the new value', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(seenRequest({ seen: true }), routeParams('prospect-1'));

    expect(updateManyMock).toHaveBeenCalledWith({ where: { id: 'prospect-1' }, data: { seen: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'prospect-1', seen: true });
  });

  it('can set seen back to false', async () => {
    updateManyMock.mockResolvedValue({ count: 1 });

    const response = await PATCH(seenRequest({ seen: false }), routeParams('prospect-1'));

    expect(await response.json()).toEqual({ id: 'prospect-1', seen: false });
  });
});
