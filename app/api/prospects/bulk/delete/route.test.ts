import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const deleteProspectMock = vi.fn();
vi.mock('@/features/prospects/prospects.repository', () => ({
  deleteProspect: deleteProspectMock,
}));

const { POST } = await import('./route');

function bulkDeleteRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/bulk/delete', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/prospects/bulk/delete', () => {
  it('returns 400 when ids is missing or empty', async () => {
    const response = await POST(bulkDeleteRequest({ ids: [] }));

    expect(response.status).toBe(400);
    expect(deleteProspectMock).not.toHaveBeenCalled();
  });

  it('maps each deletion outcome to a per-id ok result', async () => {
    deleteProspectMock
      .mockResolvedValueOnce({ outcome: 'deleted', id: 'prospect-1' })
      .mockResolvedValueOnce({ outcome: 'not_found' });

    const response = await POST(bulkDeleteRequest({ ids: ['prospect-1', 'missing-id'] }));

    expect(deleteProspectMock).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      results: [
        { id: 'prospect-1', ok: true },
        { id: 'missing-id', ok: false, reason: 'Prospect not found.' },
      ],
    });
  });

  it('skips a do-not-contact prospect with its own reason without blocking the rest of the batch', async () => {
    deleteProspectMock
      .mockResolvedValueOnce({ outcome: 'blocked_do_not_contact' })
      .mockResolvedValueOnce({ outcome: 'deleted', id: 'prospect-2' });

    const response = await POST(bulkDeleteRequest({ ids: ['dnc-prospect', 'prospect-2'] }));

    expect(deleteProspectMock).toHaveBeenCalledWith('dnc-prospect');
    expect(deleteProspectMock).toHaveBeenCalledWith('prospect-2');
    expect(await response.json()).toEqual({
      results: [
        { id: 'dnc-prospect', ok: false, reason: 'Cannot delete a do-not-contact prospect.' },
        { id: 'prospect-2', ok: true },
      ],
    });
  });
});
