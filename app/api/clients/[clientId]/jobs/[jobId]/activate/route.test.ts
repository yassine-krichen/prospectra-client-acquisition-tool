import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const findUniqueJobMock = vi.fn();
vi.mock('@/common/db/client', () => ({
  prisma: { job: { findUnique: findUniqueJobMock } },
}));

const markJobRecurringActiveMock = vi.fn();
vi.mock('@/features/retention/retention-job-status.service', () => ({
  markJobRecurringActive: markJobRecurringActiveMock,
}));

const { POST } = await import('./route');

function activateRequest(): NextRequest {
  return new NextRequest('http://localhost/api/clients/client-1/jobs/job-1/activate', { method: 'POST' });
}

function routeParams(clientId: string, jobId: string): { params: Promise<{ clientId: string; jobId: string }> } {
  return { params: Promise.resolve({ clientId, jobId }) };
}

describe('POST /api/clients/[clientId]/jobs/[jobId]/activate', () => {
  it('returns 404 without calling markJobRecurringActive when no Job exists with the given id', async () => {
    findUniqueJobMock.mockResolvedValue(null);

    const response = await POST(activateRequest(), routeParams('client-1', 'missing-job'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Job not found.' });
    expect(markJobRecurringActiveMock).not.toHaveBeenCalled();
  });

  it('returns 404 without calling markJobRecurringActive when the Job exists but belongs to a different Client', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-other' });

    const response = await POST(activateRequest(), routeParams('client-1', 'job-1'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Job not found.' });
    expect(markJobRecurringActiveMock).not.toHaveBeenCalled();
  });

  it('calls markJobRecurringActive with the jobId taken from the route params once ownership is confirmed', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-1' });
    markJobRecurringActiveMock.mockResolvedValue({ outcome: 'activated' });

    await POST(activateRequest(), routeParams('client-1', 'job-1'));

    expect(markJobRecurringActiveMock).toHaveBeenCalledWith('job-1');
  });

  it('returns 200 with outcome activated', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-1' });
    markJobRecurringActiveMock.mockResolvedValue({ outcome: 'activated' });

    const response = await POST(activateRequest(), routeParams('client-1', 'job-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'activated' });
  });

  it('returns 200 with outcome already_active, matching the per-item-outcome convention', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-1' });
    markJobRecurringActiveMock.mockResolvedValue({ outcome: 'already_active' });

    const response = await POST(activateRequest(), routeParams('client-1', 'job-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'already_active' });
  });

  it('returns 200 (not an error status) with outcome not_eligible for a one-off or non-active Job', async () => {
    findUniqueJobMock.mockResolvedValue({ clientId: 'client-1' });
    markJobRecurringActiveMock.mockResolvedValue({ outcome: 'not_eligible' });

    const response = await POST(activateRequest(), routeParams('client-1', 'job-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'not_eligible' });
  });
});
