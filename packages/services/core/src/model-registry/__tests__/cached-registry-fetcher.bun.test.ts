import { describe, it, expect } from 'bun:test';
import { CachedRegistryFetcher } from '../cached-registry-fetcher.js';
import type { ModelRegistry } from '../schemas.js';
import type { IModelRegistryCache, IModelRegistryFetcher } from '../types.js';

const mockRegistry: ModelRegistry = {
  $schema: 'makaio/model-registry/v2',
  updatedAt: '2026-01-30T12:00:00.000Z',
  labs: {
    test: {
      name: 'Test Lab',
      models: [{ name: 'm1', friendlyName: 'M1', contextWindowSize: 8000, labId: 'test' }],
    },
  },
  providers: {
    test: {
      name: 'Test Provider',
      models: { m1: {} },
    },
  },
};

const staleRegistry: ModelRegistry = {
  $schema: 'makaio/model-registry/v2',
  updatedAt: '2025-01-01T00:00:00.000Z',
  labs: {},
  providers: {
    stale: {
      name: 'Stale Provider',
      models: {},
    },
  },
};

/**
 * In-memory cache for testing.
 */
class MemoryCache implements IModelRegistryCache {
  public data: ModelRegistry | null = null;
  public setCount = 0;

  public async get(): Promise<ModelRegistry | null> {
    return this.data;
  }

  public async set(registry: ModelRegistry): Promise<void> {
    this.data = registry;
    this.setCount++;
  }
}

describe('CachedRegistryFetcher', () => {
  it('should return inner result and cache it on success', async () => {
    const inner: IModelRegistryFetcher = { fetch: async () => mockRegistry };
    const cache = new MemoryCache();
    const cached = new CachedRegistryFetcher(inner, cache);

    const result = await cached.fetch();

    expect(result).toEqual(mockRegistry);
    expect(cache.data).toEqual(mockRegistry);
    expect(cache.setCount).toBe(1);
  });

  it('should return cached data when inner fetcher fails', async () => {
    const inner: IModelRegistryFetcher = {
      fetch: async () => {
        throw new Error('network down');
      },
    };
    const cache = new MemoryCache();
    cache.data = staleRegistry;

    const cached = new CachedRegistryFetcher(inner, cache);
    const result = await cached.fetch();

    expect(result).toEqual(staleRegistry);
  });

  it('should rethrow when inner fails and no cache exists', async () => {
    const inner: IModelRegistryFetcher = {
      fetch: async () => {
        throw new Error('network down');
      },
    };
    const cache = new MemoryCache();

    const cached = new CachedRegistryFetcher(inner, cache);

    await expect(cached.fetch()).rejects.toThrow('network down');
  });

  it('should still return result when cache.set() fails', async () => {
    const inner: IModelRegistryFetcher = { fetch: async () => mockRegistry };
    const failingCache: IModelRegistryCache = {
      get: async () => null,
      set: async () => {
        throw new Error('disk full');
      },
    };

    const cached = new CachedRegistryFetcher(inner, failingCache);
    const result = await cached.fetch();

    expect(result).toEqual(mockRegistry);
  });

  it('should update cache with fresh data even when cache exists', async () => {
    const inner: IModelRegistryFetcher = { fetch: async () => mockRegistry };
    const cache = new MemoryCache();
    cache.data = staleRegistry;

    const cached = new CachedRegistryFetcher(inner, cache);
    const result = await cached.fetch();

    expect(result).toEqual(mockRegistry);
    expect(cache.data).toEqual(mockRegistry);
  });
});
