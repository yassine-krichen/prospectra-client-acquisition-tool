import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runDiscoveryMock = vi.fn();
vi.mock('@/features/discovery/discovery.service', () => ({ runDiscovery: runDiscoveryMock }));

const { POST } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
});

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pipeline/discover', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function queryRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/pipeline/discover?${query}`, { method: 'POST' });
}

const summary = {
  query: { category: 'plumber', geography: 'Austin, TX' },
  branch: 'a',
  sources: [{ source: 'google_places', ran: true, count: 3 }],
  totalFound: 3,
  inserted: 2,
  updated: 1,
  skippedDoNotContact: 0,
};

describe('POST /api/pipeline/discover', () => {
  it('runs runDiscovery and returns its summary when category and geography are provided as a JSON body', async () => {
    runDiscoveryMock.mockResolvedValue(summary);

    const response = await POST(jsonRequest({ category: 'plumber', geography: 'Austin, TX' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runDiscoveryMock).toHaveBeenCalledWith({ category: 'plumber', geography: 'Austin, TX' }, 'a', undefined);
    expect(body).toEqual(summary);
  });

  it('runs runDiscovery using query params when the request body is not valid JSON', async () => {
    runDiscoveryMock.mockResolvedValue(summary);

    const response = await POST(queryRequest('category=plumber&geography=Austin%2C+TX'));

    expect(response.status).toBe(200);
    expect(runDiscoveryMock).toHaveBeenCalledWith({ category: 'plumber', geography: 'Austin, TX' }, 'a', undefined);
  });

  it('passes the branch through to runDiscovery when provided in the JSON body', async () => {
    runDiscoveryMock.mockResolvedValue({ ...summary, branch: 'b' });

    await POST(jsonRequest({ category: 'plumber', geography: 'Austin, TX', branch: 'b' }));

    expect(runDiscoveryMock).toHaveBeenCalledWith({ category: 'plumber', geography: 'Austin, TX' }, 'b', undefined);
  });

  it('passes sources through to runDiscovery when provided in the JSON body', async () => {
    runDiscoveryMock.mockResolvedValue(summary);

    await POST(jsonRequest({ category: 'plumber', geography: 'Austin, TX', sources: ['yellowpages'] }));

    expect(runDiscoveryMock).toHaveBeenCalledWith(
      { category: 'plumber', geography: 'Austin, TX' },
      'a',
      ['yellowpages']
    );
  });

  it('returns 400 and never calls runDiscovery when neither the body nor the query params supply category/geography', async () => {
    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'category and geography are required.' });
    expect(runDiscoveryMock).not.toHaveBeenCalled();
  });

  it('returns 400 when geography is missing from both the body and the query params', async () => {
    const response = await POST(queryRequest('category=plumber'));

    expect(response.status).toBe(400);
    expect(runDiscoveryMock).not.toHaveBeenCalled();
  });
});
