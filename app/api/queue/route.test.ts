import { describe, expect, it, vi } from 'vitest';

const listApprovalQueueMock = vi.fn();
vi.mock('@/features/sending/queue-listing', () => ({ listApprovalQueue: listApprovalQueueMock }));

const { GET } = await import('./route');

describe('GET /api/queue', () => {
  it('returns 200 with the approval queue listing exactly as listApprovalQueue reports it', async () => {
    const queueResult = {
      items: [
        {
          prospectId: 'prospect-1',
          companyName: 'Acme Inc',
          contactName: 'Jane Doe',
          contactEmail: 'jane@acme.com',
          doNotContact: false,
          priorityScore: 5,
          drafts: [],
          defaultDraftId: null,
        },
      ],
      capStatus: { domainVerified: false, effectiveDailyCap: 3, sentToday: 1 },
    };
    listApprovalQueueMock.mockResolvedValue(queueResult);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(queueResult);
  });
});
