import { describe, it, expect } from 'vitest';
import { FallbackRegistryFetcher } from '../fallback-registry-fetcher.js';
import type { ModelRegistry } from '../schemas.js';
import type { IModelRegistryFetcher } from '../types.js';

const registryA: ModelRegistry = {
  $schema: 'makaio/model-registry/v2',
  updatedAt: '2026-01-01T00:00:00.000Z',
  labs: {
    a: { name: 'Lab A', models: [{ name: 'model-a', contextWindowSize: 8000, labId: 'a' }] },
  },
  providers: {
    'provider-a': { name: 'Provider A', models: { 'model-a': {} } },
  },
};

const registryB: ModelRegistry = {
  $schema: 'makaio/model-registry/v2',
  updatedAt: '2026-02-01T00:00:00.000Z',
  labs: {
    b: { name: 'Lab B', models: [{ name: 'model-b', contextWindowSize: 8000, labId: 'b' }] },
  },
  providers: {
    'provider-b': { name: 'Provider B', models: { 'model-b': {} } },
  },
};

/**
 * Creates a fetcher that succeeds with the given registry.
 * @param registry - The registry to return
 */
function succeeding(registry: ModelRegistry): IModelRegistryFetcher {
  return { fetch: async () => registry };
}

/**
 * Creates a fetcher that always throws.
 * @param message - The error message to throw
 */
function failing(message: string): IModelRegistryFetcher {
  return {
    fetch: async () => {
      throw new Error(message);
    },
  };
}

describe('FallbackRegistryFetcher', () => {
  it('should throw when constructed with empty array', () => {
    expect(() => new FallbackRegistryFetcher([])).toThrow('requires at least one fetcher');
  });

  it('should return result from first successful fetcher', async () => {
    const chain = new FallbackRegistryFetcher([succeeding(registryA), succeeding(registryB)]);

    const result = await chain.fetch();

    expect(result).toEqual(registryA);
  });

  it('should skip failing fetchers and return next success', async () => {
    const chain = new FallbackRegistryFetcher([failing('source 1 down'), succeeding(registryB)]);

    const result = await chain.fetch();

    expect(result).toEqual(registryB);
  });

  it('should throw last error when all fetchers fail', async () => {
    const chain = new FallbackRegistryFetcher([failing('error 1'), failing('error 2')]);

    await expect(chain.fetch()).rejects.toThrow('error 2');
  });

  it('should work with a single fetcher', async () => {
    const chain = new FallbackRegistryFetcher([succeeding(registryA)]);

    const result = await chain.fetch();

    expect(result).toEqual(registryA);
  });

  it('should not call later fetchers after first success', async () => {
    let secondCalled = false;
    const second: IModelRegistryFetcher = {
      fetch: async () => {
        secondCalled = true;
        return registryB;
      },
    };

    const chain = new FallbackRegistryFetcher([succeeding(registryA), second]);
    await chain.fetch();

    expect(secondCalled).toBe(false);
  });
});
