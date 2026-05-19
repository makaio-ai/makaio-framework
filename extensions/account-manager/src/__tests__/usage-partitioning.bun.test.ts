import { describe, expect, it } from 'bun:test';
import { createUsageCacheKey, parseUsageCacheKey } from '../usage/usage-partitioning.js';

describe('usage cache key partitioning', () => {
  it('round-trips opaque ids that contain colons', () => {
    const key = createUsageCacheKey('provider:region', 'account:tenant');

    expect(parseUsageCacheKey(key)).toEqual({
      clientId: 'provider:region',
      accountId: 'account:tenant',
    });
  });

  it('stays collision-free for ambiguous delimiter-only tuples', () => {
    expect(createUsageCacheKey('a:b', 'c')).not.toBe(createUsageCacheKey('a', 'b:c'));
  });
});
