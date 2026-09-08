import { describe, expect, it } from 'vitest';

import { mapInBatches } from './map-in-batches';

describe('mapInBatches', () => {
  it('maps every item and preserves order', async () => {
    const result = await mapInBatches([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it('never runs more than batchSize items concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapInBatches(Array.from({ length: 23 }, (_, i) => i), 5, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n;
    });

    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent, not accidentally serial
  });

  it('calls onBatchComplete once per batch with a running processed/total count, including a smaller final batch', async () => {
    const calls: Array<[number, number]> = [];

    await mapInBatches([1, 2, 3, 4, 5], 2, async (n) => n, (processed, total) => calls.push([processed, total]));

    expect(calls).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it('passes just that batch\'s own results to onBatchComplete, not the running total', async () => {
    const batches: number[][] = [];

    await mapInBatches(
      [1, 2, 3, 4, 5],
      2,
      async (n) => n * 100,
      (_processed, _total, batchResults) => batches.push(batchResults)
    );

    expect(batches).toEqual([[100, 200], [300, 400], [500]]);
  });

  it('returns an empty array and never calls onBatchComplete for an empty input', async () => {
    let called = false;
    const result = await mapInBatches([], 5, async (n: number) => n, () => {
      called = true;
    });

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('propagates a rejection from any item rather than swallowing it', async () => {
    await expect(
      mapInBatches([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
  });
});
