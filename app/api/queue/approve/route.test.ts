import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const approveDraftsMock = vi.fn();
vi.mock('@/features/sending/send-queue.service', () => ({ approveDrafts: approveDraftsMock }));

const { POST } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
});

function approveRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/queue/approve', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function rawApproveRequest(rawBody: string): NextRequest {
  return new NextRequest('http://localhost/api/queue/approve', {
    method: 'POST',
    body: rawBody,
  });
}

describe('POST /api/queue/approve', () => {
  it('passes the parsed approvals through to approveDrafts and returns its per-item results as-is', async () => {
    approveDraftsMock.mockResolvedValue([
      { draftId: 'draft-1', outcome: 'sent' },
      { draftId: 'draft-2', outcome: 'skipped_cap' },
    ]);

    const response = await POST(approveRequest({ approvals: [{ draftId: 'draft-1' }, { draftId: 'draft-2' }] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(approveDraftsMock).toHaveBeenCalledWith([{ draftId: 'draft-1' }, { draftId: 'draft-2' }]);
    expect(body).toEqual({
      results: [
        { draftId: 'draft-1', outcome: 'sent' },
        { draftId: 'draft-2', outcome: 'skipped_cap' },
      ],
    });
  });

  it('fails closed with 400 and never calls approveDrafts when approvals is an empty array', async () => {
    const response = await POST(approveRequest({ approvals: [] }));

    expect(response.status).toBe(400);
    expect(approveDraftsMock).not.toHaveBeenCalled();
  });

  it('fails closed with 400 and never calls approveDrafts when the approvals field is missing entirely', async () => {
    const response = await POST(approveRequest({}));

    expect(response.status).toBe(400);
    expect(approveDraftsMock).not.toHaveBeenCalled();
  });

  it('fails closed with 400 and never calls approveDrafts when a draftId is an empty string', async () => {
    const response = await POST(approveRequest({ approvals: [{ draftId: '' }] }));

    expect(response.status).toBe(400);
    expect(approveDraftsMock).not.toHaveBeenCalled();
  });

  // The exploit from the security review: {approvals: [{draftId:"x"}, {draftId:"x"}, {draftId:"x"}]}
  // must never reach approveDrafts and trigger a real multi-send for one
  // approval click. Rejected outright (fail closed) rather than silently
  // collapsed, so the client gets an explicit error instead of a
  // surprising partial result.
  it('fails closed with 400 and never calls approveDrafts when approvals contains a duplicate draftId', async () => {
    const response = await POST(
      approveRequest({ approvals: [{ draftId: 'draft-1' }, { draftId: 'draft-1' }, { draftId: 'draft-1' }] })
    );

    expect(response.status).toBe(400);
    expect(approveDraftsMock).not.toHaveBeenCalled();
  });

  it('fails closed with 400 when the same draftId appears twice with different editedBody values', async () => {
    const response = await POST(
      approveRequest({
        approvals: [
          { draftId: 'draft-1', editedBody: 'first edit' },
          { draftId: 'draft-1', editedBody: 'second edit' },
        ],
      })
    );

    expect(response.status).toBe(400);
    expect(approveDraftsMock).not.toHaveBeenCalled();
  });

  it('allows a request with distinct draftIds through unaffected by the duplicate check', async () => {
    approveDraftsMock.mockResolvedValue([
      { draftId: 'draft-1', outcome: 'sent' },
      { draftId: 'draft-2', outcome: 'sent' },
    ]);

    const response = await POST(approveRequest({ approvals: [{ draftId: 'draft-1' }, { draftId: 'draft-2' }] }));

    expect(response.status).toBe(200);
    expect(approveDraftsMock).toHaveBeenCalledWith([{ draftId: 'draft-1' }, { draftId: 'draft-2' }]);
  });

  it('fails closed with 400 and never calls approveDrafts when the request body is not valid JSON', async () => {
    const response = await POST(rawApproveRequest('not valid json'));

    expect(response.status).toBe(400);
    expect(approveDraftsMock).not.toHaveBeenCalled();
  });

  it('passes editedBody through to approveDrafts unchanged when provided', async () => {
    approveDraftsMock.mockResolvedValue([{ draftId: 'draft-1', outcome: 'sent' }]);

    await POST(approveRequest({ approvals: [{ draftId: 'draft-1', editedBody: 'a human-edited draft' }] }));

    expect(approveDraftsMock).toHaveBeenCalledWith([{ draftId: 'draft-1', editedBody: 'a human-edited draft' }]);
  });
});
