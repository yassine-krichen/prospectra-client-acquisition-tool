import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const createJobMock = vi.fn();
vi.mock('@/features/clients/create-job.service', () => ({
  createJob: createJobMock,
}));

const { POST } = await import('./route');

function jobsRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/clients/client-1/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function routeParams(clientId: string): { params: Promise<{ clientId: string }> } {
  return { params: Promise.resolve({ clientId }) };
}

describe('POST /api/clients/[clientId]/jobs payload validation', () => {
  it('returns 400 and never calls createJob for a body missing required fields', async () => {
    const response = await POST(jobsRequest({}), routeParams('client-1'));

    expect(response.status).toBe(400);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a negative agreedPriceCents', async () => {
    const response = await POST(
      jobsRequest({ service: 'landing_page', agreedPriceCents: -100 }),
      routeParams('client-1')
    );

    expect(response.status).toBe(400);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid service value', async () => {
    const response = await POST(
      jobsRequest({ service: 'not_a_real_service', agreedPriceCents: 100_000 }),
      routeParams('client-1')
    );

    expect(response.status).toBe(400);
    expect(createJobMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/clients/[clientId]/jobs delegation', () => {
  it('calls createJob with the clientId from route params and the parsed body', async () => {
    createJobMock.mockResolvedValue({ outcome: 'created', jobId: 'job-1' });

    await POST(jobsRequest({ service: 'landing_page', agreedPriceCents: 100_000 }), routeParams('client-1'));

    expect(createJobMock).toHaveBeenCalledWith('client-1', { service: 'landing_page', agreedPriceCents: 100_000 });
  });

  it('returns 404 when the Client does not exist', async () => {
    createJobMock.mockResolvedValue({ outcome: 'client_not_found' });

    const response = await POST(
      jobsRequest({ service: 'landing_page', agreedPriceCents: 100_000 }),
      routeParams('missing-client')
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Client not found.' });
  });

  it('returns 400 when createJob reports invalid_input (e.g. mismatched retainerDiscount)', async () => {
    createJobMock.mockResolvedValue({ outcome: 'invalid_input', reason: 'retainerDiscount is only valid for the infra_hosting_retainer service.' });

    const response = await POST(
      jobsRequest({ service: 'landing_page', agreedPriceCents: 100_000, retainerDiscount: 'free' }),
      routeParams('client-1')
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'retainerDiscount is only valid for the infra_hosting_retainer service.' });
  });

  it('returns 201 with outcome created and the new jobId on success', async () => {
    createJobMock.mockResolvedValue({ outcome: 'created', jobId: 'job-1' });

    const response = await POST(jobsRequest({ service: 'landing_page', agreedPriceCents: 100_000 }), routeParams('client-1'));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ outcome: 'created', jobId: 'job-1' });
  });
});
