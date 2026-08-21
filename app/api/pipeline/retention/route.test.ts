import { describe, expect, it, vi } from 'vitest';

const runRetentionSchedulerMock = vi.fn();
vi.mock('@/features/retention/retention-scheduler', () => ({
  runRetentionScheduler: runRetentionSchedulerMock,
}));

const { POST } = await import('./route');

describe('POST /api/pipeline/retention', () => {
  it('runs runRetentionScheduler and returns 200 with its results', async () => {
    runRetentionSchedulerMock.mockResolvedValue([{ jobId: 'job-1', outcome: 'sent', touchNumber: 1 }]);

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runRetentionSchedulerMock).toHaveBeenCalled();
    expect(body).toEqual({ results: [{ jobId: 'job-1', outcome: 'sent', touchNumber: 1 }] });
  });

  it('returns 200 with an empty results array when no Job is due for a retention touch', async () => {
    runRetentionSchedulerMock.mockResolvedValue([]);

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ results: [] });
  });
});
