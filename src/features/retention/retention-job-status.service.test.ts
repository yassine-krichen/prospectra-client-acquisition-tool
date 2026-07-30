import { beforeEach, describe, expect, it, vi } from 'vitest';

// markJobDelivered/markJobRecurringActive are the sole entry points allowed
// to flip a Job `active -> delivered`/`active -> monthly` — same "one atomic
// claim, conditioned on exactly the state just read" pattern as
// convert-to-client.service.ts. Prisma is mocked (orchestration test, not a
// real-DB test).
const { findUniqueJobMock, updateManyJobMock } = vi.hoisted(() => ({
  findUniqueJobMock: vi.fn(),
  updateManyJobMock: vi.fn(),
}));

vi.mock('@/common/db/client', () => ({
  prisma: { job: { findUnique: findUniqueJobMock, updateMany: updateManyJobMock } },
}));

const { markJobDelivered, markJobRecurringActive } = await import('./retention-job-status.service');

interface JobRowOverrides {
  id?: string;
  cadence?: string;
  status?: string;
  statusHistory?: unknown;
}

function buildJobRow(overrides: JobRowOverrides = {}) {
  return {
    id: overrides.id ?? 'job-1',
    cadence: overrides.cadence ?? 'one_off',
    status: overrides.status ?? 'active',
    statusHistory: overrides.statusHistory ?? [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueJobMock.mockResolvedValue(buildJobRow());
  updateManyJobMock.mockResolvedValue({ count: 1 });
});

describe('markJobDelivered', () => {
  it('returns not_found when no Job exists with the given id', async () => {
    findUniqueJobMock.mockResolvedValue(null);

    const result = await markJobDelivered('missing-id');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(updateManyJobMock).not.toHaveBeenCalled();
  });

  it('returns not_eligible without attempting the claim for a recurring Job (a retainer never "delivers")', async () => {
    findUniqueJobMock.mockResolvedValue(buildJobRow({ cadence: 'recurring' }));

    const result = await markJobDelivered('job-1');

    expect(result).toEqual({ outcome: 'not_eligible' });
    expect(updateManyJobMock).not.toHaveBeenCalled();
  });

  it('returns already_delivered without attempting the claim when the Job is already delivered', async () => {
    findUniqueJobMock.mockResolvedValue(buildJobRow({ status: 'delivered' }));

    const result = await markJobDelivered('job-1');

    expect(result).toEqual({ outcome: 'already_delivered' });
    expect(updateManyJobMock).not.toHaveBeenCalled();
  });

  it('claims the Job active -> delivered, setting deliveredAt and freeRevisionWindowEndsAt 30 days later', async () => {
    const result = await markJobDelivered('job-1');

    expect(updateManyJobMock).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'active', cadence: 'one_off' },
      data: {
        status: 'delivered',
        deliveredAt: expect.any(Date),
        freeRevisionWindowEndsAt: expect.any(Date),
        statusHistory: [expect.objectContaining({ status: 'delivered' })],
      },
    });

    expect(result.outcome).toBe('delivered');
    if (result.outcome !== 'delivered') throw new Error('expected delivered outcome');

    const deltaMs = result.freeRevisionWindowEndsAt.getTime() - result.deliveredAt.getTime();
    expect(deltaMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('re-checks and reports already_delivered when the claim is lost because a concurrent call already delivered it', async () => {
    updateManyJobMock.mockResolvedValue({ count: 0 });
    findUniqueJobMock.mockResolvedValueOnce(buildJobRow()).mockResolvedValueOnce({ status: 'delivered' });

    const result = await markJobDelivered('job-1');

    expect(result).toEqual({ outcome: 'already_delivered' });
  });

  it('re-checks and reports not_eligible when the claim is lost for any other reason (e.g. cancelled concurrently)', async () => {
    updateManyJobMock.mockResolvedValue({ count: 0 });
    findUniqueJobMock.mockResolvedValueOnce(buildJobRow()).mockResolvedValueOnce({ status: 'cancelled' });

    const result = await markJobDelivered('job-1');

    expect(result).toEqual({ outcome: 'not_eligible' });
  });
});

describe('markJobRecurringActive', () => {
  it('returns not_found when no Job exists with the given id', async () => {
    findUniqueJobMock.mockResolvedValue(null);

    const result = await markJobRecurringActive('missing-id');

    expect(result).toEqual({ outcome: 'not_found' });
    expect(updateManyJobMock).not.toHaveBeenCalled();
  });

  it('returns not_eligible without attempting the claim for a one-off Job', async () => {
    findUniqueJobMock.mockResolvedValue(buildJobRow({ cadence: 'one_off' }));

    const result = await markJobRecurringActive('job-1');

    expect(result).toEqual({ outcome: 'not_eligible' });
    expect(updateManyJobMock).not.toHaveBeenCalled();
  });

  it('returns already_active without attempting the claim when the Job is already monthly', async () => {
    findUniqueJobMock.mockResolvedValue(buildJobRow({ cadence: 'recurring', status: 'monthly' }));

    const result = await markJobRecurringActive('job-1');

    expect(result).toEqual({ outcome: 'already_active' });
    expect(updateManyJobMock).not.toHaveBeenCalled();
  });

  it('claims the Job active -> monthly for a recurring Job', async () => {
    findUniqueJobMock.mockResolvedValue(buildJobRow({ cadence: 'recurring', status: 'active' }));

    const result = await markJobRecurringActive('job-1');

    expect(updateManyJobMock).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'active', cadence: 'recurring' },
      data: { status: 'monthly', statusHistory: [expect.objectContaining({ status: 'monthly' })] },
    });
    expect(result).toEqual({ outcome: 'activated' });
  });

  it('re-checks and reports already_active when the claim is lost because a concurrent call already activated it', async () => {
    findUniqueJobMock.mockResolvedValueOnce(buildJobRow({ cadence: 'recurring', status: 'active' }));
    updateManyJobMock.mockResolvedValue({ count: 0 });
    findUniqueJobMock.mockResolvedValueOnce({ status: 'monthly' });

    const result = await markJobRecurringActive('job-1');

    expect(result).toEqual({ outcome: 'already_active' });
  });
});
