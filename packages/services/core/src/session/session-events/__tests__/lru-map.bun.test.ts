import { describe, it, expect } from 'bun:test';
import { LruMap } from '../lru-map.js';

describe('LruMap', () => {
  it('stores and retrieves entries like a regular Map', () => {
    const map = new LruMap<string, number>(10);
    map.set('a', 1);
    map.set('b', 2);
    expect(map.get('a')).toBe(1);
    expect(map.get('b')).toBe(2);
    expect(map.size).toBe(2);
  });

  it('returns undefined for missing keys', () => {
    const map = new LruMap<string, number>(10);
    expect(map.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when maxSize is exceeded on set', () => {
    const map = new LruMap<string, number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    // Insert a fourth entry — 'a' is LRU and should be evicted.
    map.set('d', 4);
    expect(map.size).toBe(3);
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toBe(2);
    expect(map.get('c')).toBe(3);
    expect(map.get('d')).toBe(4);
  });

  it('promotes an entry to MRU on get, protecting it from eviction', () => {
    const map = new LruMap<string, number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    // Read 'a' to promote it to MRU — 'b' becomes the new LRU.
    map.get('a');
    map.set('d', 4);
    expect(map.has('b')).toBe(false);
    expect(map.has('a')).toBe(true);
    expect(map.has('c')).toBe(true);
    expect(map.has('d')).toBe(true);
  });

  it('promotes an existing key to MRU on set without growing the map', () => {
    const map = new LruMap<string, number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    // Re-set 'a' — should move it to MRU without exceeding maxSize.
    map.set('a', 99);
    expect(map.size).toBe(3);
    // Now 'b' is LRU; inserting 'd' should evict 'b'.
    map.set('d', 4);
    expect(map.has('b')).toBe(false);
    expect(map.get('a')).toBe(99);
  });

  it('supports delete and has inherited from Map', () => {
    const map = new LruMap<string, number>(5);
    map.set('x', 10);
    map.set('y', 20);
    map.delete('x');
    expect(map.has('x')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('stores null and undefined values without treating them as absent', () => {
    const nullMap = new LruMap<string, string | null>(5);
    nullMap.set('a', null);
    expect(nullMap.has('a')).toBe(true);
    expect(nullMap.get('a')).toBeNull();

    const undefMap = new LruMap<string, string | undefined>(5);
    undefMap.set('b', undefined);
    expect(undefMap.has('b')).toBe(true);
    expect(undefMap.get('b')).toBeUndefined();
  });

  it('evicts an undefined key correctly when capacity is exceeded', () => {
    const map = new LruMap<string | undefined, number>(1);
    map.set(undefined, 1);
    map.set('b', 2);
    expect(map.has(undefined)).toBe(false);
    expect(map.get('b')).toBe(2);
  });

  it('handles a maxSize of 1 correctly', () => {
    const map = new LruMap<string, number>(1);
    map.set('a', 1);
    map.set('b', 2);
    expect(map.size).toBe(1);
    expect(map.has('a')).toBe(false);
    expect(map.get('b')).toBe(2);
  });

  it('throws RangeError for invalid maxSize values', () => {
    expect(() => new LruMap(0)).toThrow(RangeError);
    expect(() => new LruMap(-1)).toThrow(RangeError);
    expect(() => new LruMap(1.5)).toThrow(RangeError);
    expect(() => new LruMap(NaN)).toThrow(RangeError);
  });
});
