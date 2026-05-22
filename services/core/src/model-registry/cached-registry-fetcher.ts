import type { IModelRegistryCache, IModelRegistryFetcher } from './types.js';
import type { ModelRegistry } from './schemas.js';

/**
 * Decorator that adds disk/persistent caching around a fetcher.
 *
 * On success: caches the result for future use.
 * On failure: returns cached data if available, otherwise rethrows
 * so the next fetcher in a fallback chain can be tried.
 * @example
 * ```typescript
 * const cached = new CachedRegistryFetcher(
 *   new CdnRegistryFetcher('https://example.com/model-registry.yaml'),
 *   new FileRegistryCache(path.join(makaioHome, 'cache', 'model-registry.json')),
 * );
 * ```
 */
export class CachedRegistryFetcher implements IModelRegistryFetcher {
  private readonly inner: IModelRegistryFetcher;
  private readonly cache: IModelRegistryCache;

  /**
   * Creates a new CachedRegistryFetcher.
   * @param inner - The fetcher to wrap with caching
   * @param cache - The cache implementation for persistence
   */
  public constructor(inner: IModelRegistryFetcher, cache: IModelRegistryCache) {
    this.inner = inner;
    this.cache = cache;
  }

  /**
   * Fetch from the inner fetcher with cache fallback.
   * @returns Registry from inner fetcher (fresh) or cache (stale fallback)
   * @throws Error if inner fetch fails and no cached data exists
   */
  public async fetch(): Promise<ModelRegistry> {
    try {
      const result = await this.inner.fetch();
      // Cache write is non-fatal — don't let disk errors discard a good fetch
      await this.cache.set(result).catch((err) => {
        console.warn('[CachedRegistryFetcher] Failed to write cache:', err);
      });
      return result;
    } catch (error) {
      const cached = await this.cache.get();
      if (cached !== null) {
        return cached;
      }
      throw error;
    }
  }
}
