import { describe, expect, it, vi } from 'vitest';

import { listClientsResponseSchema } from '@/features/clients/client.types';

const listClientsMock = vi.fn();
vi.mock('@/features/clients/clients.repository', () => ({ listClients: listClientsMock }));

const { GET } = await import('./route');

describe('GET /api/clients', () => {
  it('returns 200 with the clients array exactly as listClients reports it', async () => {
    const clients = [
      {
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
        jobs: [],
      },
    ];
    listClientsMock.mockResolvedValue(clients);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ clients: JSON.parse(JSON.stringify(clients)) });
    expect(listClientsResponseSchema.parse(body)).toBeTruthy();
  });

  it('returns 200 with an empty clients array when there are no Clients', async () => {
    listClientsMock.mockResolvedValue([]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ clients: [] });
  });
});
