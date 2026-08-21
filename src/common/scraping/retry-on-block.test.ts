import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { retryOnBlock, ScraperBlockedError } from './retry-on-block';

describe('retryOnBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result immediately when the first attempt succeeds, without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await retryOnBlock(fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-ScraperBlockedError immediately without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('some other failure'));

    const promise = retryOnBlock(fn);
    // Flush the rejected microtask before asserting.
    await expect(promise).rejects.toThrow('some other failure');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the 2nd attempt after one ScraperBlockedError, without a 3rd call', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ScraperBlockedError('blocked once'))
      .mockResolvedValueOnce('ok');

    const promise = retryOnBlock(fn);
    // Let the first attempt's rejection register before advancing the delay timer.
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('waits the configured delay between attempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ScraperBlockedError('blocked once'))
      .mockResolvedValueOnce('ok');

    const promise = retryOnBlock(fn, 3, [2000, 5000]);

    // Before the delay elapses, the 2nd attempt must not have happened yet.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBe('ok');
  });

  it('reuses the last configured delay once attempts exceed delaysMs.length', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ScraperBlockedError('blocked 1'))
      .mockRejectedValueOnce(new ScraperBlockedError('blocked 2'))
      .mockResolvedValueOnce('ok');

    // 3 attempts, but only 2 delays configured - the 2nd-to-3rd gap should
    // reuse the last entry (5000ms) rather than being undefined/0.
    const promise = retryOnBlock(fn, 3, [2000, 5000]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toBe('ok');
  });

  it('rethrows the last ScraperBlockedError after all attempts are exhausted', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ScraperBlockedError('first block'))
      .mockRejectedValueOnce(new ScraperBlockedError('second block'))
      .mockRejectedValueOnce(new ScraperBlockedError('final block'));

    const promise = retryOnBlock(fn, 3, [2000, 5000]);
    const assertion = expect(promise).rejects.toThrow('final block');

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not delay after the final attempt fails', async () => {
    const fn = vi.fn().mockRejectedValue(new ScraperBlockedError('always blocked'));

    const promise = retryOnBlock(fn, 2, [2000]);
    const assertion = expect(promise).rejects.toThrow('always blocked');

    await vi.advanceTimersByTimeAsync(2000);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
