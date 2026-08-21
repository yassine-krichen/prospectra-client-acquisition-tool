import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const enrichProspectMock = vi.fn();
vi.mock('@/features/enrichment/enrichment.service', () => ({ enrichProspect: enrichProspectMock }));

const { POST } = await import('./route');

function bulkEnrichRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/prospects/bulk/enrich', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/prospects/bulk/enrich', () => {
  it('returns 400 when ids is missing or empty', async () => {
    const response = await POST(bulkEnrichRequest({ ids: [] }));

    expect(response.status).toBe(400);
    expect(enrichProspectMock).not.toHaveBeenCalled();
  });

  it('calls enrichProspect once per id, sequentially, and reports a per-id ok result', async () => {
    const callOrder: string[] = [];
    enrichProspectMock.mockImplementation(async (id: string) => {
      callOrder.push(id);
      return id === 'missing-id' ? null : { prospect: { id }, sources: [] };
    });

    const response = await POST(bulkEnrichRequest({ ids: ['prospect-1', 'missing-id'] }));

    expect(callOrder).toEqual(['prospect-1', 'missing-id']);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { id: 'prospect-1', ok: true },
        { id: 'missing-id', ok: false, reason: 'Prospect not found.' },
      ],
    });
  });
});
