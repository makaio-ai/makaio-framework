import { describe, expect, it } from 'vitest';
import { createRightsCache, RIGHTS_CACHE_MAX_ENTRIES } from '../rights-cache.js';

describe('rights cache size bound', () => {
  it('evicts the single oldest entry once insertions pass the limit, and keeps the newest', () => {
    const cache = createRightsCache();
    const right = 'ext.owner.read';

    for (let i = 0; i < RIGHTS_CACHE_MAX_ENTRIES; i++) {
      cache.set(`key-${i}`, right, { granted: true }, 0);
    }
    // Filled exactly to the bound: nothing evicted yet.
    expect(cache.get('key-0')).toEqual({ granted: true });
    expect(cache.get(`key-${RIGHTS_CACHE_MAX_ENTRIES - 1}`)).toEqual({ granted: true });

    // One more insertion crosses the bound.
    cache.set('key-overflow', right, { granted: false, reason: 'not-public' }, 0);

    // The single oldest entry is gone...
    expect(cache.get('key-0')).toBeUndefined();
    // ...but the entry right after it, and the newly inserted one, both survive.
    expect(cache.get('key-1')).toEqual({ granted: true });
    expect(cache.get('key-overflow')).toEqual({ granted: false, reason: 'not-public' });
  });
});
