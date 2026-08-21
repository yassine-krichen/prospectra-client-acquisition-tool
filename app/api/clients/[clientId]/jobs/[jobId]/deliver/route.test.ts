import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const findUniqueJobMock = vi.fn();
vi.mock('@/common/db/client', () => ({
  prisma: { job: { findUnique: findUniqueJobMock } },
}));

const markJobDeliveredMock = vi.fn();
vi.mock('@/features/retention/retention-job-status.service', () => ({
  markJobDelivered: markJobDeliveredMock,
}));

const { POST } = await import('./route');

function deliverRequest(): NextRequest {
  return new NextRequest('http://localhost/api/clients/client-1/jobs/job-1/deliver', { method: 'POST' });
}

function routeParams(clientId: string, jobId: string): { params: Promise<{ clientId: string; jobId: string }> } {
  return { params: Promise.resolve({ clientId, jobId }) };
}

describe('POST /api/clients/[clientId]/jobs/[jobId]/deliver', () => {
  it('returns 404 without calling markJobDelivered when no Job exists with the given id', async () => {
    findUniqueJobMock.mockResolvedValue(null);

    const response = await POST(deliverRequest(), routeParams('client-1', 'missing-job'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Job not found.' });
    expect(markJobDeliveredMock).not.toHaveBeenCalled();
  });

  it('returns 404 without calling markJobDelivered when the Job exists but belongs to a different Client', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-other' });

    const response = await POST(deliverRequest(), routeParams('client-1', 'job-1'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Job not found.' });
    expect(markJobDeliveredMock).not.toHaveBeenCalled();
  });

  it('calls markJobDelivered with the jobId taken from the route params once ownership is confirmed', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-1' });
    markJobDeliveredMock.mockResolvedValue({
      outcome: 'delivered',
      deliveredAt: new Date('2026-01-01T00:00:00.000Z'),
      freeRevisionWindowEndsAt: new Date('2026-01-31T00:00:00.000Z'),
    });

    await POST(deliverRequest(), routeParams('client-1', 'job-1'));

    expect(markJobDeliveredMock).toHaveBeenCalledWith('job-1');
  });

  it('returns 200 with outcome delivered and the resulting timestamps', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-1' });
    const deliveredAt = new Date('2026-01-01T00:00:00.000Z');
    const freeRevisionWindowEndsAt = new Date('2026-01-31T00:00:00.000Z');
    markJobDeliveredMock.mockResolvedValue({ outcome: 'delivered', deliveredAt, freeRevisionWindowEndsAt });

    const response = await POST(deliverRequest(), routeParams('client-1', 'job-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: 'delivered',
      deliveredAt: deliveredAt.toISOString(),
      freeRevisionWindowEndsAt: freeRevisionWindowEndsAt.toISOString(),
    });
  });

  it('returns 200 with outcome already_delivered, matching the per-item-outcome convention', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-1' });
    markJobDeliveredMock.mockResolvedValue({ outcome: 'already_delivered' });

    const response = await POST(deliverRequest(), routeParams('client-1', 'job-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'already_delivered' });
  });

  it('returns 200 (not an error status) with outcome not_eligible for a recurring or non-active Job', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-1' });
    markJobDeliveredMock.mockResolvedValue({ outcome: 'not_eligible' });

    const response = await POST(deliverRequest(), routeParams('client-1', 'job-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'not_eligible' });
  });
});
