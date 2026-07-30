import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const applyServiceMatchingMock = vi.fn();
vi.mock('@/features/matching/matching.service', () => ({ applyServiceMatching: applyServiceMatchingMock }));

const { POST } = await import('./route');

function matchRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1/match', { method: 'POST' });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/prospects/[id]/match', () => {
  it('returns 404 with an error message when no prospect exists with the given id', async () => {
    applyServiceMatchingMock.mockResolvedValue({ outcome: 'not_found', prospectId: 'missing-id' });

    const response = await POST(matchRequest(), routeParams('missing-id'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Prospect not found.' });
  });

  it('calls applyServiceMatching with the id taken from the route params', async () => {
    applyServiceMatchingMock.mockResolvedValue({ outcome: 'applied', prospectId: 'prospect-1', suggestedServices: [] });

    await POST(matchRequest(), routeParams('prospect-1'));

    expect(applyServiceMatchingMock).toHaveBeenCalledWith('prospect-1');
  });

  it('returns 200 with the applied outcome and suggestedServices', async () => {
    const suggestedServices = [
      {
        service: 'landing_page',
        role: 'primary',
        priceRangeCents: { min: 80_000, max: 150_000 },
        requiresManualQuote: false,
        reasoning: 'x',
        source: 'rules',
      },
    ];
    applyServiceMatchingMock.mockResolvedValue({ outcome: 'applied', prospectId: 'prospect-1', suggestedServices });

    const response = await POST(matchRequest(), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'applied', prospectId: 'prospect-1', suggestedServices });
  });

  it('returns 200 (not an error status) with outcome invalid_signal, matching the per-item-outcome convention', async () => {
    applyServiceMatchingMock.mockResolvedValue({ outcome: 'invalid_signal', prospectId: 'prospect-1', reason: 'bad signal' });

    const response = await POST(matchRequest(), routeParams('prospect-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'invalid_signal', prospectId: 'prospect-1', reason: 'bad signal' });
  });
});
