import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { env } from '@/common/config/env';

const runRetentionSchedulerMock = vi.fn();
vi.mock('@/features/retention/retention-scheduler', () => ({
  runRetentionScheduler: runRetentionSchedulerMock,
}));

const { POST } = await import('./route');

function cronRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/cron/retention', { method: 'POST', headers });
}

describe('POST /api/cron/retention', () => {
  it('rejects the request with 401 when the x-cron-secret header is missing entirely', async () => {
    const response = await POST(cronRequest());

    expect(response.status).toBe(401);
    expect(runRetentionSchedulerMock).not.toHaveBeenCalled();
  });

  it('rejects the request with 401 when the x-cron-secret header does not match the configured secret', async () => {
    const response = await POST(cronRequest({ 'x-cron-secret': 'definitely-the-wrong-secret' }));

    expect(response.status).toBe(401);
    expect(runRetentionSchedulerMock).not.toHaveBeenCalled();
  });

  it('runs runRetentionScheduler and returns 200 with its results when the secret matches', async () => {
    runRetentionSchedulerMock.mockResolvedValue([{ jobId: 'job-1', outcome: 'sent', touchNumber: 1 }]);

    const response = await POST(cronRequest({ 'x-cron-secret': env.CRON_SECRET }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runRetentionSchedulerMock).toHaveBeenCalled();
    expect(body).toEqual({ results: [{ jobId: 'job-1', outcome: 'sent', touchNumber: 1 }] });
  });

  it('never echoes the configured CRON_SECRET back in the unauthorized error response body', async () => {
    const response = await POST(cronRequest({ 'x-cron-secret': 'wrong-secret' }));
    const body = await response.json();

    expect(JSON.stringify(body)).not.toContain(env.CRON_SECRET);
  });
});
