import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const draftProspectMock = vi.fn();
vi.mock('@/features/drafting/drafting.service', () => ({ draftProspect: draftProspectMock }));

const { POST } = await import('./route');

function draftRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1/draft', { method: 'POST' });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/prospects/[id]/draft', () => {
  it('returns 404 with an error message when no prospect exists with the given id', async () => {
    draftProspectMock.mockResolvedValue(null);

    const response = await POST(draftRequest(), routeParams('missing-id'));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: 'Prospect not found.' });
  });

  it('calls draftProspect with the id taken from the route params', async () => {
    draftProspectMock.mockResolvedValue({ ok: true, drafts: [], humanize: { attempted: false } });

    await POST(draftRequest(), routeParams('prospect-1'));

    expect(draftProspectMock).toHaveBeenCalledWith('prospect-1');
  });

  it('returns 200 with the flagged outcome surfaced as-is when a prospect has no valid signal on file', async () => {
    draftProspectMock.mockResolvedValue({
      ok: false,
      flagged: 'missing_signal',
      message: 'prospect has no valid signal on file — drafting requires signal.description/evidence',
    });

    const response = await POST(draftRequest(), routeParams('prospect-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: false,
      flagged: 'missing_signal',
      message: 'prospect has no valid signal on file — drafting requires signal.description/evidence',
    });
  });

  it('returns 200 with the created drafts on a successful drafting result', async () => {
    draftProspectMock.mockResolvedValue({
      ok: true,
      drafts: [
        {
          id: 'draft-1',
          prospectId: 'prospect-1',
          variant: 1,
          subject: 'Subject',
          body: 'Body',
          humanizedBody: null,
          modelUsed: 'gemini',
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          edited: false,
          approved: false,
        },
      ],
      humanize: { attempted: false },
    });

    const response = await POST(draftRequest(), routeParams('prospect-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.drafts).toHaveLength(1);
  });
});
