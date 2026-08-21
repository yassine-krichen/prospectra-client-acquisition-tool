import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const draftProspectMock = vi.fn();
vi.mock('@/features/drafting/drafting.service', () => ({ draftProspect: draftProspectMock }));

const { POST } = await import('./route');

function bulkDraftRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/bulk/draft', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/prospects/bulk/draft', () => {
  it('returns 400 when ids is missing or empty', async () => {
    const response = await POST(bulkDraftRequest({ ids: [] }));

    expect(response.status).toBe(400);
    expect(draftProspectMock).not.toHaveBeenCalled();
  });

  it('reports ok:false with the not-found reason for a missing prospect', async () => {
    draftProspectMock.mockResolvedValue(null);

    const response = await POST(bulkDraftRequest({ ids: ['missing-id'] }));

    expect(await response.json()).toEqual({
      results: [{ id: 'missing-id', ok: false, reason: 'Prospect not found.' }],
    });
  });

  it('reports ok:true for a successful draft and ok:false with the flagged message otherwise', async () => {
    draftProspectMock.mockReset();
    draftProspectMock
      .mockResolvedValueOnce({ ok: true, drafts: [], humanize: { attempted: false } })
      .mockResolvedValueOnce({ ok: false, flagged: 'missing_signal', message: 'no signal on file' });

    const response = await POST(bulkDraftRequest({ ids: ['prospect-1', 'prospect-2'] }));

    expect(draftProspectMock).toHaveBeenNthCalledWith(1, 'prospect-1');
    expect(draftProspectMock).toHaveBeenNthCalledWith(2, 'prospect-2');
    expect(await response.json()).toEqual({
      results: [
        { id: 'prospect-1', ok: true },
        { id: 'prospect-2', ok: false, reason: 'no signal on file' },
      ],
    });
  });
});
