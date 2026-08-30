/**
 * Maps `items` through `mapItem`, `batchSize` at a time (each batch run
 * concurrently via `Promise.all`, the next batch not started until the
 * current one finishes) - the middle ground between a plain sequential
 * `for` loop (safe but slow: N items each waiting for the last one to
 * finish) and a bare `Promise.all(items.map(mapItem))` (fast but
 * unbounded: N simultaneous in-flight operations, however large N is).
 *
 * Extracted after the same "unbounded Promise.all over a network call, no
 * cap on N" shape caused two separate problems in this codebase - Overpass
 * (a broad query returning thousands of OSM elements, each needing its own
 * website fetch) and discovery.service.ts's enrichment chain (fired
 * against every discovered prospect in one run, same scale) - see each
 * call site for the specific numbers that made this necessary.
 */
export async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  mapItem: (item: T) => Promise<R>,
  // `batchResults` (just this batch's own results, not the running total) is
  // passed so a caller that wants a running derived stat - overpass.source.ts
  // counts non-null prospects across batches, for instance - can fold it in
  // itself, without this generic helper needing to know what "count" means
  // for any particular caller.
  onBatchComplete?: (processedCount: number, totalCount: number, batchResults: R[]) => void
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(mapItem));
    results.push(...batchResults);
    onBatchComplete?.(Math.min(i + batchSize, items.length), items.length, batchResults);
  }

  return results;
}
