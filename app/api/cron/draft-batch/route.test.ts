import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { env } from '@/common/config/env';

const draftBatchMock = vi.fn();
const humanizeBatchMock = vi.fn();
vi.mock('@/features/drafting/drafting.service', () => ({
  draftBatch: draftBatchMock,
  humanizeBatch: humanizeBatchMock,
}));

const { POST } = await import('./route');

function cronRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/cron/draft-batch', { method: 'POST', headers });
}

describe('POST /api/cron/draft-batch', () => {
  it('rejects the request with 401 when the x-cron-secret header is missing entirely', async () => {
    const response = await POST(cronRequest());

    expect(response.status).toBe(401);
    expect(draftBatchMock).not.toHaveBeenCalled();
    expect(humanizeBatchMock).not.toHaveBeenCalled();
  });

  it('rejects the request with 401 when the x-cron-secret header does not match the configured secret', async () => {
    const response = await POST(cronRequest({ 'x-cron-secret': 'definitely-the-wrong-secret' }));

    expect(response.status).toBe(401);
    expect(draftBatchMock).not.toHaveBeenCalled();
    expect(humanizeBatchMock).not.toHaveBeenCalled();
  });

  it('runs draftBatch then humanizeBatch and returns 200 with both summaries when the secret matches', async () => {
    draftBatchMock.mockResolvedValue([{ prospectId: 'prospect-1', outcome: { ok: true, drafts: [], humanize: { attempted: false } } }]);
    humanizeBatchMock.mockResolvedValue({ attempted: 0, results: [] });

    const response = await POST(cronRequest({ 'x-cron-secret': env.CRON_SECRET }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(draftBatchMock).toHaveBeenCalled();
    expect(humanizeBatchMock).toHaveBeenCalled();
    expect(body).toEqual({
      drafted: [{ prospectId: 'prospect-1', outcome: { ok: true, drafts: [], humanize: { attempted: false } } }],
      humanized: { attempted: 0, results: [] },
    });
  });

  it('never echoes the configured CRON_SECRET back in the unauthorized error response body', async () => {
    const response = await POST(cronRequest({ 'x-cron-secret': 'wrong-secret' }));
    const body = await response.json();

    expect(JSON.stringify(body)).not.toContain(env.CRON_SECRET);
  });
});
