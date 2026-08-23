import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/common/config/env';
import { NY_TARGET_GEOGRAPHY, pickDailyCategory } from '@/features/discovery/ny-target-categories';

const runDiscoveryMock = vi.fn();
vi.mock('@/features/discovery/discovery.service', () => ({
  runDiscovery: runDiscoveryMock,
}));

const { GET, POST } = await import('./route');

afterEach(() => {
  runDiscoveryMock.mockClear();
});

function cronRequest(method: string, headers: Record<string, string> = {}, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/cron/discover', {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/cron/discover', () => {
  it('rejects the request with 401 when the x-cron-secret header does not match', async () => {
    const response = await POST(cronRequest('POST', { 'x-cron-secret': 'wrong-secret' }, {}));

    expect(response.status).toBe(401);
    expect(runDiscoveryMock).not.toHaveBeenCalled();
  });

  it('runs runDiscovery with the caller-supplied category/geography/branch when authorized', async () => {
    runDiscoveryMock.mockResolvedValue({ totalFound: 3 });

    const response = await POST(
      cronRequest('POST', { 'x-cron-secret': env.CRON_SECRET, 'content-type': 'application/json' }, {
        category: 'plumber',
        geography: 'Austin, TX',
        branch: 'a',
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runDiscoveryMock).toHaveBeenCalledWith({ category: 'plumber', geography: 'Austin, TX' }, 'a');
    expect(body).toEqual({ totalFound: 3 });
  });
});

describe('GET /api/cron/discover', () => {
  it('rejects the request with 401 when there is no Authorization bearer token', async () => {
    const response = await GET(cronRequest('GET'));

    expect(response.status).toBe(401);
    expect(runDiscoveryMock).not.toHaveBeenCalled();
  });

  it('rejects a plain x-cron-secret header - this handler only accepts the Bearer scheme', async () => {
    const response = await GET(cronRequest('GET', { 'x-cron-secret': env.CRON_SECRET }));

    expect(response.status).toBe(401);
  });

  it("runs runDiscovery with today's rotated NY category, the fixed NY geography, and branch 'both'", async () => {
    runDiscoveryMock.mockResolvedValue({ totalFound: 5 });

    const response = await GET(cronRequest('GET', { authorization: `Bearer ${env.CRON_SECRET}` }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runDiscoveryMock).toHaveBeenCalledWith(
      { category: pickDailyCategory(new Date()), geography: NY_TARGET_GEOGRAPHY },
      'both'
    );
    expect(body).toEqual({ totalFound: 5 });
  });
});
