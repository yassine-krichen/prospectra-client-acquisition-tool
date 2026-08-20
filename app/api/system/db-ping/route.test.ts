import { describe, expect, it, vi } from 'vitest';

const queryRawMock = vi.fn();
vi.mock('@/common/db/client', () => ({
  prisma: { $queryRaw: queryRawMock },
}));

const { GET } = await import('./route');

describe('GET /api/system/db-ping', () => {
  it('returns ok:true with a measured latency and good:true when the query is fast', async () => {
    queryRawMock.mockResolvedValue([{ '?column?': 1 }]);

    const response = await GET();
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(typeof body.latencyMs).toBe('number');
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.good).toBe(true);
  });

  it('marks good:false when the query takes 100ms or more', async () => {
    queryRawMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([{ '?column?': 1 }]), 105)));

    const response = await GET();
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.latencyMs).toBeGreaterThanOrEqual(100);
    expect(body.good).toBe(false);
  });

  it('returns ok:false with the error message and good:false when the query throws', async () => {
    queryRawMock.mockRejectedValue(new Error('connection refused'));

    const response = await GET();
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.latencyMs).toBeNull();
    expect(body.good).toBe(false);
    expect(body.error).toBe('connection refused');
  });
});
