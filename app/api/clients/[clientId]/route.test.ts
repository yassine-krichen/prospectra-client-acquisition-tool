import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { clientSchema } from '@/features/clients/client.types';

const getClientWithJobsMock = vi.fn();
vi.mock('@/features/clients/clients.repository', () => ({ getClientWithJobs: getClientWithJobsMock }));

const { GET } = await import('./route');

function clientRequest(clientId: string): NextRequest {
  return new NextRequest(`http://localhost/api/clients/${clientId}`);
}

function routeParams(clientId: string): { params: Promise<{ clientId: string }> } {
  return { params: Promise.resolve({ clientId }) };
}

describe('GET /api/clients/[clientId]', () => {
  it('returns 200 with the Client and its Jobs exactly as getClientWithJobs reports it', async () => {
    const client = {
      id: 'client-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      prospectId: null,
      companyName: 'Acme Inc',
      domain: 'acme.com',
      contactName: 'Jane Doe',
      contactTitle: 'CEO',
      contactEmail: 'jane@acme.com',
      industry: 'other',
      companySize: '1-10',
      doNotContact: false,
      notes: null,
      statusHistory: [],
      jobs: [
        {
          id: 'job-1',
          clientId: 'client-1',
          service: 'landing_page',
          cadence: 'one_off',
          status: 'active',
          agreedPriceCents: 100_000,
          soldAt: new Date('2026-01-01T00:00:00.000Z'),
          deliveredAt: null,
          freeRevisionRoundsUsed: 0,
          freeRevisionWindowEndsAt: null,
          retainerDiscount: null,
          retainerDiscountEndsAt: null,
          lastRetentionTouchAt: null,
          retentionTouchCount: 0,
          statusHistory: [],
          notes: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    };
    getClientWithJobsMock.mockResolvedValue(client);

    const response = await GET(clientRequest('client-1'), routeParams('client-1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ client: JSON.parse(JSON.stringify(client)) });
    expect(getClientWithJobsMock).toHaveBeenCalledWith('client-1');
    expect(clientSchema.parse(body.client)).toBeTruthy();
  });

  it('returns 404 when getClientWithJobs finds no Client with the given id', async () => {
    getClientWithJobsMock.mockResolvedValue(null);

    const response = await GET(clientRequest('missing-client'), routeParams('missing-client'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Client not found.' });
  });
});
