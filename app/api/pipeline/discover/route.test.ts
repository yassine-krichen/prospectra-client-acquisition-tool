import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveryStreamLine } from '@/features/discovery/discovery.types';

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

async function readStreamLines(response: Response): Promise<DiscoveryStreamLine[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DiscoveryStreamLine);
}

const summary = {
  query: { category: 'plumber', geography: 'Austin, TX' },
  branch: 'a',
  sources: [{ source: 'google_places', ran: true, count: 3 }],
  totalFound: 3,
  inserted: 2,
  updated: 1,
  skippedDoNotContact: 0,
  discardedThinProspects: 0,
};

describe('POST /api/pipeline/discover', () => {
  it('streams progress lines from runDiscovery followed by a summary line', async () => {
    runDiscoveryMock.mockImplementation(async (_input, _branch, _sources, onProgress) => {
      onProgress({ level: 'info', message: 'Starting discovery' });
      onProgress({ level: 'success', message: 'google_places: found 3 prospect(s)' });
      return summary;
    });

    const response = await POST(jsonRequest({ category: 'plumber', geography: 'Austin, TX' }));
    const lines = await readStreamLines(response);

    expect(response.status).toBe(200);
    expect(lines).toEqual([
      { type: 'progress', level: 'info', message: 'Starting discovery' },
      { type: 'progress', level: 'success', message: 'google_places: found 3 prospect(s)' },
      { type: 'summary', summary },
    ]);
  });

  it('passes category/geography/branch/sources through to runDiscovery, plus an onProgress callback', async () => {
    runDiscoveryMock.mockResolvedValue(summary);

    await POST(jsonRequest({ category: 'plumber', geography: 'Austin, TX', branch: 'b', sources: ['yellowpages'] }));

    expect(runDiscoveryMock).toHaveBeenCalledWith(
      { category: 'plumber', geography: 'Austin, TX' },
      'b',
      ['yellowpages'],
      expect.any(Function)
    );
  });

  it('runs runDiscovery using query params when the request body is not valid JSON', async () => {
    runDiscoveryMock.mockResolvedValue(summary);

    const response = await POST(queryRequest('category=plumber&geography=Austin%2C+TX'));
    const lines = await readStreamLines(response);

    expect(response.status).toBe(200);
    expect(runDiscoveryMock).toHaveBeenCalledWith(
      { category: 'plumber', geography: 'Austin, TX' },
      'a',
      undefined,
      expect.any(Function)
    );
    expect(lines).toEqual([{ type: 'summary', summary }]);
  });

  it('streams an error line instead of throwing when runDiscovery rejects', async () => {
    runDiscoveryMock.mockRejectedValue(new Error('boom'));

    const response = await POST(jsonRequest({ category: 'plumber', geography: 'Austin, TX' }));
    const lines = await readStreamLines(response);

    expect(response.status).toBe(200);
    expect(lines).toEqual([{ type: 'error', message: 'boom' }]);
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
