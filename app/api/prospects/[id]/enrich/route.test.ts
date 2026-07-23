import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const enrichProspectMock = vi.fn();
vi.mock('@/features/enrichment/enrichment.service', () => ({ enrichProspect: enrichProspectMock }));

const { POST } = await import('./route');

function enrichRequest(): NextRequest {
  return new NextRequest('http://localhost/api/prospects/prospect-1/enrich', { method: 'POST' });
}

function routeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/prospects/[id]/enrich', () => {
  it('returns 404 with an error message when no prospect exists with the given id', async () => {
    enrichProspectMock.mockResolvedValue(null);

    const response = await POST(enrichRequest(), routeParams('missing-id'));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: 'Prospect not found.' });
  });

  it('calls enrichProspect with the id taken from the route params', async () => {
    enrichProspectMock.mockResolvedValue({
      prospect: {
        id: 'prospect-1',
        companyName: 'Acme Inc',
        domain: 'acme.com',
        contactName: 'Jane Doe',
        contactTitle: 'CEO',
        contactEmail: 'jane@acme.com',
        emailVerified: true,
        emailConfidence: 95,
        linkedinUrl: null,
        status: 'enriched',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      sources: [{ source: 'hunter', ran: true, used: true }],
    });

    await POST(enrichRequest(), routeParams('prospect-1'));

    expect(enrichProspectMock).toHaveBeenCalledWith('prospect-1');
  });

  it('returns the scoped enriched-prospect view (contact fields, status, updatedAt) rather than the full Prospect shape', async () => {
    enrichProspectMock.mockResolvedValue({
      prospect: {
        id: 'prospect-1',
        companyName: 'Acme Inc',
        domain: 'acme.com',
        contactName: 'Jane Doe',
        contactTitle: 'CEO',
        contactEmail: 'jane@acme.com',
        emailVerified: true,
        emailConfidence: 95,
        linkedinUrl: null,
        status: 'enriched',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      sources: [
        { source: 'hunter', ran: true, used: true },
        { source: 'people_data_labs', ran: false, reason: 'already found a usable contact', used: false },
      ],
    });

    const response = await POST(enrichRequest(), routeParams('prospect-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.prospect).toMatchObject({
      id: 'prospect-1',
      contactName: 'Jane Doe',
      contactEmail: 'jane@acme.com',
      status: 'enriched',
    });
    // Fields that exist on the full Prospect shape but not the scoped
    // enrichment view should never appear here.
    expect(body.prospect).not.toHaveProperty('statusHistory');
    expect(body.prospect).not.toHaveProperty('drafts');
    expect(body.prospect).not.toHaveProperty('tags');
    expect(body.sources).toHaveLength(2);
  });
});
