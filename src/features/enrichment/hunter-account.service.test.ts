import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ HUNTER_API_KEY: undefined as string | undefined }));
vi.mock('@/common/config/env', () => ({ env: envMock }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { getHunterAccountUsage } = await import('./hunter-account.service');

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('getHunterAccountUsage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    envMock.HUNTER_API_KEY = undefined;
  });

  it('reports configured:false and never calls fetch when HUNTER_API_KEY is unset', async () => {
    const result = await getHunterAccountUsage();

    expect(result.configured).toBe(false);
    expect(result.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns real used/available/remaining/plan/reset date from the API response', async () => {
    envMock.HUNTER_API_KEY = 'test-hunter-key';
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          plan_name: 'Free',
          reset_date: '2026-08-24',
          requests: { searches: { used: 3, available: 50, remaining: 47 } },
        },
      })
    );

    const result = await getHunterAccountUsage();

    expect(result).toEqual({
      configured: true,
      planName: 'Free',
      used: 3,
      available: 50,
      remaining: 47,
      resetDate: '2026-08-24',
      error: null,
    });
    const [calledUrl] = fetchMock.mock.calls[0] as [URL];
    expect(calledUrl.toString()).toBe('https://api.hunter.io/v2/account?api_key=test-hunter-key');
  });

  it('returns an error result (not a thrown exception) on a non-2xx status', async () => {
    envMock.HUNTER_API_KEY = 'test-hunter-key';
    fetchMock.mockResolvedValue(jsonResponse(401, { errors: [{ details: 'invalid api key' }] }));

    const result = await getHunterAccountUsage();

    expect(result.configured).toBe(true);
    expect(result.used).toBeNull();
    expect(result.error).toContain('401');
  });

  it('returns an error result when the network request itself throws', async () => {
    envMock.HUNTER_API_KEY = 'test-hunter-key';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getHunterAccountUsage();

    expect(result.configured).toBe(true);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns an error result when the response body does not match the expected shape', async () => {
    envMock.HUNTER_API_KEY = 'test-hunter-key';
    fetchMock.mockResolvedValue(jsonResponse(200, { unexpected: true }));

    const result = await getHunterAccountUsage();

    expect(result.configured).toBe(true);
    expect(result.error).toContain('expected shape');
  });
});
