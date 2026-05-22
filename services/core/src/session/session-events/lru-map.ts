/**
 * Least-recently-used (LRU) map with a fixed capacity.
 *
 * Extends the built-in `Map` so it can be used anywhere a `Map` is accepted.
 * Eviction policy: when a `set` would push the size past `maxSize`, the entry
 * that was least recently read or written is dropped.
 *
 * Implementation relies on the ECMAScript-specified insertion-order iteration
 * of `Map`. Every `get` and `set` moves the affected key to the end of the
 * iteration order (most-recently used). The first key in iteration order is
 * therefore always the least-recently used and is the eviction target.
 */
export class LruMap<K, V> extends Map<K, V> {
  /**
   * @param maxSize - Maximum number of entries. When exceeded, the
   *   least-recently-used entry is evicted. Must be a positive integer.
   */
  public constructor(private readonly maxSize: number) {
    super();
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError('maxSize must be a positive integer');
    }
  }

  /**
   * Retrieve a value and promote the entry to most-recently used.
   * @param key - The key to look up
   * @returns The associated value, or `undefined` if the key is absent
   */
  public override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    // Promote to MRU position by re-inserting at the end.
    const value = super.get(key) as V;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  /**
   * Insert or update a key-value pair, evicting the LRU entry if necessary.
   *
   * If the key already exists it is moved to the most-recently-used position.
   * If inserting a new key would exceed `maxSize`, the least-recently-used
   * entry (first in iteration order) is removed before the new entry is added.
   * @param key - The key to set
   * @param value - The value to associate with the key
   * @returns `this` (chainable, per Map contract)
   */
  public override set(key: K, value: V): this {
    // Move existing key to MRU position.
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    if (super.size > this.maxSize) {
      // Check the `done` flag rather than `value === undefined` because
      // Map allows `undefined` as a valid key.
      const first = super.keys().next();
      if (!first.done) super.delete(first.value);
    }
    return this;
  }
}
