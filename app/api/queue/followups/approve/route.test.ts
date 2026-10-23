import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const approveFollowupsMock = vi.fn();
vi.mock('@/features/followups/followup-approval.service', () => ({ approveFollowups: approveFollowupsMock }));

const { POST } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
});

function approveRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/queue/followups/approve', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/queue/followups/approve', () => {
  it('passes the prospect ids to approveFollowups and returns its per-prospect results', async () => {
    approveFollowupsMock.mockResolvedValue([{ prospectId: 'p1', outcome: 'sent', touch: 2 }]);

    const response = await POST(approveRequest({ prospectIds: ['p1'] }));

    expect(response.status).toBe(200);
    expect(approveFollowupsMock).toHaveBeenCalledWith(['p1']);
    expect(await response.json()).toEqual({ results: [{ prospectId: 'p1', outcome: 'sent', touch: 2 }] });
  });

  it('returns 400 for duplicate prospect ids without sending anything', async () => {
    const response = await POST(approveRequest({ prospectIds: ['p1', 'p1'] }));

    expect(response.status).toBe(400);
    expect(approveFollowupsMock).not.toHaveBeenCalled();
  });

  it('returns 400 when more prospect ids are sent than one request may approve', async () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `p${index}`);

    const response = await POST(approveRequest({ prospectIds: tooMany }));

    expect(response.status).toBe(400);
    expect(approveFollowupsMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty list or a malformed body', async () => {
    expect((await POST(approveRequest({ prospectIds: [] }))).status).toBe(400);
    expect((await POST(approveRequest({ nope: true }))).status).toBe(400);
    expect(approveFollowupsMock).not.toHaveBeenCalled();
  });
});
