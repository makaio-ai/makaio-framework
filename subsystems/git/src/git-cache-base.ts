import QuickLRU from 'quick-lru';

/**
 * Cached result entry stored internally by the cache.
 * @typeParam TResponse - Response type for the cached result
 */
interface CachedResult<TResponse> {
  response: TResponse;
  timestamp: number;
  invalidationRoot: string;
}

/**
 * Generic LRU cache with repository-based invalidation.
 *
 * Provides a common cache infrastructure for git operation results
 * (log queries, working tree details, etc.). Subclasses only need to
 * implement {@link buildKey} to define their cache key strategy.
 * @typeParam TRequest - Request type used for cache key generation
 * @typeParam TResponse - Response type for cached results
 */
export abstract class GitCacheBase<TRequest, TResponse> {
  private readonly cache: QuickLRU<string, CachedResult<TResponse>>;
  private readonly index = new Map<string, Set<string>>();

  /**
   * Creates a new cache instance.
   * @param maxSize - Maximum number of entries in the LRU cache
   */
  public constructor(maxSize = 20) {
    this.cache = new QuickLRU<string, CachedResult<TResponse>>({
      maxSize,
      onEviction: (_key, value) => {
        this.removeIndexEntry(value.invalidationRoot, _key);
      },
    });
  }

  /**
   * Retrieve a cached response for a request.
   * @param request - The request to look up
   * @param cacheKeyPath - Repository path used for keying
   * @returns Cached response if present
   */
  public get(request: TRequest, cacheKeyPath: string): TResponse | undefined {
    const key = this.buildKey(request, cacheKeyPath);
    return this.cache.get(key)?.response;
  }

  /**
   * Store a response in the cache.
   * @param request - The request used for keying
   * @param cacheKeyPath - Repository path used for keying
   * @param invalidationRoot - Repository root used for invalidation
   * @param response - Response to cache
   */
  public set(request: TRequest, cacheKeyPath: string, invalidationRoot: string, response: TResponse): void {
    const key = this.buildKey(request, cacheKeyPath);
    this.cache.set(key, { response, timestamp: Date.now(), invalidationRoot });
    const keys = this.index.get(invalidationRoot) ?? new Set<string>();
    keys.add(key);
    this.index.set(invalidationRoot, keys);
  }

  /**
   * Invalidate all cache entries for a repository.
   * @param repoPath - Repository path to invalidate
   */
  public invalidate(repoPath: string): void {
    const keys = this.index.get(repoPath);
    if (!keys) return;
    for (const key of [...keys]) {
      this.deleteEntry(repoPath, key);
    }
  }

  /**
   * Clear all cache entries.
   */
  public clear(): void {
    this.cache.clear();
    this.index.clear();
  }

  /**
   * Build a cache key from a request and repository path.
   * Subclasses define their own key strategy.
   * @param request - The request to build a key for
   * @param repoPath - Repository path for keying
   * @returns Stable string cache key
   */
  protected abstract buildKey(request: TRequest, repoPath: string): string;

  /**
   * Delete a cache entry and its index reference.
   * @param repoPath - Repository path for index lookup
   * @param key - Cache key to delete
   */
  private deleteEntry(repoPath: string, key: string): void {
    this.removeIndexEntry(repoPath, key);
    this.cache.delete(key);
  }

  /**
   * Remove a key from the repository index.
   * Cleans up the index entry if no keys remain.
   * @param repoPath - Repository path for index lookup
   * @param key - Cache key to remove from index
   */
  private removeIndexEntry(repoPath: string, key: string): void {
    const keys = this.index.get(repoPath);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) {
      this.index.delete(repoPath);
    }
  }
}
