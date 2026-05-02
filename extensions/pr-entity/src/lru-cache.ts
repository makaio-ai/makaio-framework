/** Entry stored inside the LRU cache. */
interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Map-backed LRU cache with configurable max size and TTL.
 *
 * Insertion order doubles as recency order — `Map` preserves insertion order.
 * The oldest entry is evicted when `maxSize` is exceeded.
 * @typeParam K - Cache key type
 * @typeParam V - Cache value type
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();

  /**
   * @param maxSize - Maximum number of entries before oldest-entry eviction
   * @param ttlMs - Time-to-live per entry in milliseconds
   */
  public constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {
    if (maxSize <= 0) throw new Error('LRUCache maxSize must be greater than 0');
    if (ttlMs <= 0) throw new Error('LRUCache ttlMs must be greater than 0');
  }

  /**
   * Retrieve a cached value if present and not expired.
   *
   * Refreshes recency on a cache hit (moves the entry to the tail of the map).
   * @param key - Cache key to look up
   * @returns Cached value, or `undefined` when missing or expired
   */
  public get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency: delete and re-insert moves key to insertion tail
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Store a value, evicting the oldest entry when at capacity.
   * @param key - Cache key
   * @param value - Value to store
   */
  public set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Remove all entries from the cache. */
  public clear(): void {
    this.map.clear();
  }
}
