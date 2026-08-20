import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  NEON_API_KEY: undefined as string | undefined,
  NEON_PROJECT_ID: undefined as string | undefined,
}));
vi.mock('@/common/config/env', () => ({ env: envMock }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { getNeonUsage } = await import('./neon-usage.service');

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('getNeonUsage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    envMock.NEON_API_KEY = undefined;
    envMock.NEON_PROJECT_ID = undefined;
  });

  it('reports configured:false and never calls fetch when NEON_API_KEY or NEON_PROJECT_ID is unset', async () => {
    const result = await getNeonUsage();

    expect(result.configured).toBe(false);
    expect(result.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('computes real storage MB/limit/percent, compute seconds, and data transfer MB from the API response', async () => {
    envMock.NEON_API_KEY = 'napi_test';
    envMock.NEON_PROJECT_ID = 'floral-tooth-80474079';
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        project: {
          synthetic_storage_size: 40081904,
          branch_logical_size_limit_bytes: 536870912,
          compute_time_seconds: 418,
          data_transfer_bytes: 290347,
          consumption_period_start: '2026-08-20T18:03:41Z',
          consumption_period_end: '2026-09-01T00:00:00Z',
        },
      })
    );

    const result = await getNeonUsage();

    expect(result).toEqual({
      configured: true,
      storageUsedMB: 38.23,
      storageLimitMB: 512,
      storagePercentUsed: 7.5,
      computeSecondsUsed: 418,
      dataTransferMB: 0.28,
      periodStart: '2026-08-20T18:03:41Z',
      periodEnd: '2026-09-01T00:00:00Z',
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://console.neon.tech/api/v2/projects/floral-tooth-80474079',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer napi_test' }) })
    );
  });

  it('returns an error result (not a thrown exception) when Neon responds with a non-2xx status', async () => {
    envMock.NEON_API_KEY = 'napi_test';
    envMock.NEON_PROJECT_ID = 'floral-tooth-80474079';
    fetchMock.mockResolvedValue(jsonResponse(401, { message: 'unauthorized' }));

    const result = await getNeonUsage();

    expect(result.configured).toBe(true);
    expect(result.storageUsedMB).toBeNull();
    expect(result.error).toContain('401');
  });

  it('returns an error result when the network request itself throws', async () => {
    envMock.NEON_API_KEY = 'napi_test';
    envMock.NEON_PROJECT_ID = 'floral-tooth-80474079';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getNeonUsage();

    expect(result.configured).toBe(true);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns an error result when the response body does not match the expected shape', async () => {
    envMock.NEON_API_KEY = 'napi_test';
    envMock.NEON_PROJECT_ID = 'floral-tooth-80474079';
    fetchMock.mockResolvedValue(jsonResponse(200, { unexpected: true }));

    const result = await getNeonUsage();

    expect(result.configured).toBe(true);
    expect(result.error).toContain('expected shape');
  });
});
