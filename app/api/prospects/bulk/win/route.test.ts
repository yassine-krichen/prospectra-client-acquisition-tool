import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const convertProspectToClientMock = vi.fn();
vi.mock('@/features/prospects/convert-to-client.service', () => ({
  convertProspectToClient: convertProspectToClientMock,
}));

const { POST } = await import('./route');

function bulkWinRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/bulk/win', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/prospects/bulk/win', () => {
  it('returns 400 when ids is missing or empty', async () => {
    const response = await POST(bulkWinRequest({ ids: [] }));

    expect(response.status).toBe(400);
    expect(convertProspectToClientMock).not.toHaveBeenCalled();
  });

  it('maps each conversion outcome to a per-id ok result', async () => {
    convertProspectToClientMock
      .mockResolvedValueOnce({ outcome: 'converted', clientId: 'client-1' })
      .mockResolvedValueOnce({ outcome: 'already_converted', clientId: 'client-2' })
      .mockResolvedValueOnce({ outcome: 'not_found' })
      .mockResolvedValueOnce({ outcome: 'blocked_do_not_contact' });

    const response = await POST(
      bulkWinRequest({ ids: ['prospect-1', 'prospect-2', 'missing-id', 'prospect-4'] })
    );

    expect(convertProspectToClientMock).toHaveBeenCalledTimes(4);
    expect(await response.json()).toEqual({
      results: [
        { id: 'prospect-1', ok: true, clientId: 'client-1' },
        { id: 'prospect-2', ok: true, clientId: 'client-2' },
        { id: 'missing-id', ok: false, reason: 'Prospect not found.' },
        { id: 'prospect-4', ok: false, reason: 'Prospect is marked do-not-contact.' },
      ],
    });
  });
});
