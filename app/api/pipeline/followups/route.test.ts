import { describe, expect, it, vi } from 'vitest';

const runFollowupSchedulerMock = vi.fn();
vi.mock('@/features/followups/followup-scheduler', () => ({
  runFollowupScheduler: runFollowupSchedulerMock,
}));

const { POST } = await import('./route');

describe('POST /api/pipeline/followups', () => {
  it('runs runFollowupScheduler and returns 200 with its results', async () => {
    runFollowupSchedulerMock.mockResolvedValue([{ prospectId: 'prospect-1', outcome: 'sent', touch: 2 }]);

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runFollowupSchedulerMock).toHaveBeenCalled();
    expect(body).toEqual({ results: [{ prospectId: 'prospect-1', outcome: 'sent', touch: 2 }] });
  });

  it('returns 200 with an empty results array when no prospect is due for a follow-up', async () => {
    runFollowupSchedulerMock.mockResolvedValue([]);

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ results: [] });
  });
});
