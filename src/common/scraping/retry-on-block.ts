// A Cloudflare (or similar) block is transient in practice - the same source
// often succeeds on a second or third attempt seconds later. This helper
// isolates that retry policy so `yellowpages.source.ts` and
// `indiehackers.source.ts` don't each hand-roll their own backoff loop.
export class ScraperBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScraperBlockedError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying only when it throws a `ScraperBlockedError` (the
 * signal a scraper source uses for a detected bot-block, as opposed to a
 * legitimate empty result). Any other error is rethrown immediately, without
 * retrying. After `attempts` total tries, the last `ScraperBlockedError` is
 * rethrown.
 */
export async function retryOnBlock<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delaysMs: number[] = [2000, 5000]
): Promise<T> {
  let lastBlockError: ScraperBlockedError | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ScraperBlockedError)) {
        throw error;
      }
      lastBlockError = error;

      const isLastAttempt = attempt === attempts - 1;
      if (!isLastAttempt) {
        await delay(delaysMs[attempt] ?? delaysMs[delaysMs.length - 1]);
      }
    }
  }

  throw lastBlockError;
}
