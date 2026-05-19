import { describe, expect, it, spyOn } from 'bun:test';
import { LRUCache } from '../lru-cache.js';

describe('LRUCache', () => {
  it.each([
    [0, 60_000, 'maxSize'],
    [-1, 60_000, 'maxSize'],
    [10, 0, 'ttlMs'],
    [10, -1, 'ttlMs'],
  ])('rejects invalid constructor bounds maxSize=%s ttlMs=%s', (maxSize, ttlMs, expectedMessage) => {
    expect(() => new LRUCache<string, string>(maxSize, ttlMs)).toThrow(expectedMessage);
  });

  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<string, string>(10, 60_000);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(10, 60_000);
    cache.set('a', 42);
    expect(cache.get('a')).toBe(42);
  });

  it('evicts expired entries on get', () => {
    const now = Date.now();
    const spy = spyOn(Date, 'now').mockReturnValue(now);

    const cache = new LRUCache<string, string>(10, 100);
    cache.set('key', 'value');

    // Advance time past TTL
    spy.mockReturnValue(now + 200);

    expect(cache.get('key')).toBeUndefined();
    spy.mockRestore();
  });

  it('evicts oldest entry when at capacity', () => {
    const cache = new LRUCache<string, number>(3, 60_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Setting a 4th entry should evict 'a' (oldest)
    cache.set('d', 4);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('promotes accessed entries to prevent premature eviction', () => {
    const cache = new LRUCache<string, number>(3, 60_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Access 'a' to make it recently used
    cache.get('a');

    // Adding 'd' should now evict 'b' (the oldest after 'a' was promoted)
    cache.set('d', 4);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('overwrites existing keys without eviction', () => {
    const cache = new LRUCache<string, number>(2, 60_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 99); // update existing key — should not evict 'b'

    expect(cache.get('a')).toBe(99);
    expect(cache.get('b')).toBe(2);
  });

  it('clears all entries', () => {
    const cache = new LRUCache<string, number>(10, 60_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});
