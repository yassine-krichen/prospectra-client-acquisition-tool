import { beforeEach, describe, expect, it, vi } from 'vitest';

const listRecentDiscoveryRunsMock = vi.fn();
vi.mock('@/features/discovery/discovery.service', () => ({
  listRecentDiscoveryRuns: listRecentDiscoveryRunsMock,
}));

const { GET } = await import('./route');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/discovery/runs', () => {
  it('returns the listRecentDiscoveryRuns result as JSON', async () => {
    const runs = [
      {
        id: 'run-1',
        category: 'plumber',
        geography: 'Austin, TX',
        branch: 'a',
        totalFound: 3,
        inserted: 2,
        updated: 1,
        skippedDoNotContact: 0,
        sources: [],
        createdAt: new Date('2026-08-01').toISOString(),
      },
    ];
    listRecentDiscoveryRunsMock.mockResolvedValue(runs);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(runs);
    expect(listRecentDiscoveryRunsMock).toHaveBeenCalledTimes(1);
  });
});
