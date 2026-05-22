import type { IModelRegistryFetcher } from './types.js';
import type { ModelRegistry } from './schemas.js';

/**
 * Tries multiple fetchers in order, returning the first successful result.
 *
 * Each fetcher is attempted sequentially. On success, returns immediately.
 * On failure, moves to the next fetcher. If all fetchers fail, throws the
 * last error encountered.
 * @example
 * ```typescript
 * const fetcher = new FallbackRegistryFetcher([
 *   new CachedRegistryFetcher(new CdnRegistryFetcher(cdnUrl), fileCache),
 *   new BundledSeedFetcher(seedPath),
 * ]);
 * ```
 */
export class FallbackRegistryFetcher implements IModelRegistryFetcher {
  private readonly fetchers: readonly IModelRegistryFetcher[];

  /**
   * Creates a new FallbackRegistryFetcher.
   * @param fetchers - Ordered list of fetchers to try (first match wins)
   * @throws Error if fetchers array is empty
   */
  public constructor(fetchers: IModelRegistryFetcher[]) {
    if (fetchers.length === 0) {
      throw new Error('FallbackRegistryFetcher requires at least one fetcher');
    }
    this.fetchers = fetchers;
  }

  /**
   * Try each fetcher in order, returning the first successful result.
   * @returns The model registry from the first successful fetcher
   * @throws The last error if all fetchers fail
   */
  public async fetch(): Promise<ModelRegistry> {
    let lastError: Error | undefined;

    for (const fetcher of this.fetchers) {
      try {
        return await fetcher.fetch();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError!;
  }
}
