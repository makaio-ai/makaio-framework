/**
 * Tests for RegistryService
 */
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { advanceTimersByTimeAsync } from '@makaio/test-utils';
import { RegistryService } from '../registry-service.js';
import type { PackageRegistry } from '../namespace.js';

/**
 * Creates a fetch-compatible mock function that satisfies the full `typeof fetch`
 * contract, including the `preconnect` static method added in newer environments.
 * @param mockFn - The bun mock to augment
 * @returns The mock cast to `typeof fetch` with `preconnect` attached
 */
function asFetch(mockFn: ReturnType<typeof mock>): typeof fetch {
  return Object.assign(mockFn, { preconnect: mock() }) as typeof fetch;
}

/**
 * Mock registry data
 */
const mockRegistryData: PackageRegistry = {
  $schema: 'makaio/package-registry/v1',
  updatedAt: '2026-01-31T12:00:00Z',
  adapters: [
    {
      name: '@makaio/ai-adapters-claude-code',
      displayName: 'Claude Code',
      description: 'Anthropic Claude via CLI or API',
      icon: 'claude',
      tags: ['official'],
    },
  ],
  extensions: [
    {
      name: '@makaio/extension-github',
      displayName: 'GitHub',
      description: 'PR comments, issues, code review integration',
      icon: 'github',
      tags: ['official', 'integration'],
    },
  ],
};

describe('RegistryService', () => {
  let registryService: RegistryService;

  beforeEach(() => {
    mock.restore();
  });

  it('fetches registry from GitHub successfully', async () => {
    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => mockRegistryData,
    });
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    const registry = await registryService.getRegistry();

    expect(registry).toEqual(mockRegistryData);
    expect(registry.adapters).toHaveLength(1);
    expect(registry.extensions).toHaveLength(1);
  });

  it('caches registry data for subsequent calls', async () => {
    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => mockRegistryData,
    });
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    // First call - should fetch
    await registryService.getRegistry();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call - should use cache
    await registryService.getRegistry();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent cache misses into one fetch', async () => {
    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => mockRegistryData,
    });
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    const [first, second] = await Promise.all([registryService.getRegistry(), registryService.getRegistry()]);

    expect(first).toEqual(mockRegistryData);
    expect(second).toEqual(mockRegistryData);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after cache expires', async () => {
    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => mockRegistryData,
    });
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    // First call
    await registryService.getRegistry();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Clear cache manually
    registryService.clearCache();

    // Second call - should refetch
    await registryService.getRegistry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles HTTP errors', async () => {
    const fetchMock = mock().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    await expect(registryService.getRegistry()).rejects.toThrow('Failed to fetch package registry');
  });

  it('handles network errors', async () => {
    const fetchMock = mock().mockRejectedValue(new Error('Network error'));
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    await expect(registryService.getRegistry()).rejects.toThrow('Failed to fetch package registry');
  });

  it('validates registry schema', async () => {
    // Mock invalid registry data (missing required fields)
    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => ({
        $schema: 'makaio/package-registry/v1',
        // Missing updatedAt, adapters, extensions
      }),
    });
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    await expect(registryService.getRegistry()).rejects.toThrow('Failed to fetch package registry');
  });

  it('clears cache when requested', async () => {
    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => mockRegistryData,
    });
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    await registryService.getRegistry();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    registryService.clearCache();

    await registryService.getRegistry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('fetch timeout with AbortController', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('aborts and rejects after 10 seconds', async () => {
      const fetchMock = mock().mockImplementation((_url: string, options: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              reject(new Error('The operation was aborted'));
            });
          }
        });
      });
      registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

      const promise = registryService.getRegistry().catch((error) => error);

      // Fast-forward past the 10 second timeout
      await advanceTimersByTimeAsync(10_001);

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain('Failed to fetch package registry');
    });
  });

  it('clears timeout on successful fetch', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => mockRegistryData,
    });
    registryService = new RegistryService({ fetchImpl: asFetch(fetchMock) });

    await registryService.getRegistry();

    // clearTimeout should have been called in the finally block
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });
});
