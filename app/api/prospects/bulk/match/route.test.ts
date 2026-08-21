import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const applyServiceMatchingMock = vi.fn();
vi.mock('@/features/matching/matching.service', () => ({ applyServiceMatching: applyServiceMatchingMock }));

const { POST } = await import('./route');

function bulkMatchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/bulk/match', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/prospects/bulk/match', () => {
  it('returns 400 when ids is missing or empty', async () => {
    const response = await POST(bulkMatchRequest({ ids: [] }));

    expect(response.status).toBe(400);
    expect(applyServiceMatchingMock).not.toHaveBeenCalled();
  });

  it('maps each matching outcome to a per-id ok result', async () => {
    applyServiceMatchingMock
      .mockResolvedValueOnce({ outcome: 'applied', prospectId: 'prospect-1', suggestedServices: [] })
      .mockResolvedValueOnce({ outcome: 'not_found', prospectId: 'missing-id' })
      .mockResolvedValueOnce({ outcome: 'invalid_signal', prospectId: 'prospect-3', reason: 'bad signal' });

    const response = await POST(bulkMatchRequest({ ids: ['prospect-1', 'missing-id', 'prospect-3'] }));

    expect(applyServiceMatchingMock).toHaveBeenCalledTimes(3);
    expect(await response.json()).toEqual({
      results: [
        { id: 'prospect-1', ok: true },
        { id: 'missing-id', ok: false, reason: 'Prospect not found.' },
        { id: 'prospect-3', ok: false, reason: 'bad signal' },
      ],
    });
  });
});
