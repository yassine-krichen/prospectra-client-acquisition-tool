import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { env } from '@/common/config/env';

const draftBatchMock = vi.fn();
const humanizeBatchMock = vi.fn();
const runFollowupSchedulerMock = vi.fn();
const runRetentionSchedulerMock = vi.fn();
vi.mock('@/features/drafting/drafting.service', () => ({
  draftBatch: draftBatchMock,
  humanizeBatch: humanizeBatchMock,
}));
vi.mock('@/features/followups/followup-scheduler', () => ({
  runFollowupScheduler: runFollowupSchedulerMock,
}));
vi.mock('@/features/retention/retention-scheduler', () => ({
  runRetentionScheduler: runRetentionSchedulerMock,
}));

const { GET } = await import('./route');

function cronRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/cron/daily', { method: 'GET', headers });
}

describe('GET /api/cron/daily', () => {
  it('rejects the request with 401 when there is no Authorization header', async () => {
    const response = await GET(cronRequest());

    expect(response.status).toBe(401);
    expect(draftBatchMock).not.toHaveBeenCalled();
  });

  it('rejects the request with 401 when the bearer token does not match CRON_SECRET', async () => {
    const response = await GET(cronRequest({ authorization: 'Bearer definitely-the-wrong-secret' }));

    expect(response.status).toBe(401);
    expect(draftBatchMock).not.toHaveBeenCalled();
  });

  it('rejects a plain x-cron-secret header - this route only accepts the Bearer scheme', async () => {
    const response = await GET(cronRequest({ 'x-cron-secret': env.CRON_SECRET }));

    expect(response.status).toBe(401);
  });

  it('runs all four stages in order and returns 200 with each summary when the bearer token matches', async () => {
    draftBatchMock.mockResolvedValue([{ prospectId: 'prospect-1' }]);
    humanizeBatchMock.mockResolvedValue({ attempted: 0, results: [] });
    runFollowupSchedulerMock.mockResolvedValue([{ prospectId: 'prospect-2' }]);
    runRetentionSchedulerMock.mockResolvedValue([{ jobId: 'job-1' }]);

    const response = await GET(cronRequest({ authorization: `Bearer ${env.CRON_SECRET}` }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(draftBatchMock).toHaveBeenCalled();
    expect(humanizeBatchMock).toHaveBeenCalled();
    expect(runFollowupSchedulerMock).toHaveBeenCalled();
    expect(runRetentionSchedulerMock).toHaveBeenCalled();
    expect(body).toEqual({
      drafted: [{ prospectId: 'prospect-1' }],
      humanized: { attempted: 0, results: [] },
      followups: [{ prospectId: 'prospect-2' }],
      retention: [{ jobId: 'job-1' }],
    });
  });

  it('never echoes the configured CRON_SECRET back in the unauthorized error response body', async () => {
    const response = await GET(cronRequest({ authorization: 'Bearer wrong-secret' }));
    const body = await response.json();

    expect(JSON.stringify(body)).not.toContain(env.CRON_SECRET);
  });
});
