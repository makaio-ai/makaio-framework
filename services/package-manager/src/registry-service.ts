/**
 * Package Registry Service
 *
 * Fetches and caches the GitHub-hosted packages.json registry.
 * All configuration is injectable for testing and reuse.
 * @packageDocumentation
 */

import { PackageRegistrySchema, type PackageRegistry } from './schemas.js';

const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/makaio-ai/makaio/develop/registry/packages.json';
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Construction options for {@link RegistryService}.
 */
export interface RegistryServiceOptions {
  /**
   * URL of the packages.json registry.
   *
   * Defaults to the official GitHub-hosted registry.
   */
  readonly registryUrl?: string;

  /**
   * How long (in milliseconds) to keep cached registry data before
   * re-fetching.
   *
   * Defaults to one hour.
   */
  readonly cacheTtlMs?: number;

  /**
   * Milliseconds before an in-flight fetch is aborted.
   *
   * Defaults to 10 000 ms.
   */
  readonly fetchTimeoutMs?: number;

  /**
   * Fetch implementation to use.
   *
   * Inject a mock here in tests instead of mutating `global.fetch`.
   * Defaults to the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * In-memory cache entry.
 */
interface CacheEntry {
  readonly data: PackageRegistry;
  readonly timestamp: number;
}

/**
 * Fetches and caches the GitHub-hosted package registry.
 *
 * All options (URL, TTL, timeout, fetch implementation) are injectable via
 * {@link RegistryServiceOptions}, making the service straightforward to test
 * without patching globals.
 */
export class RegistryService {
  private cache: CacheEntry | null = null;
  private inFlightFetch: Promise<PackageRegistry> | null = null;
  private readonly registryUrl: string;
  private readonly cacheTtlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  /**
   * @param options - Optional overrides for URL, cache TTL, timeout, and fetch.
   */
  public constructor(options: RegistryServiceOptions = {}) {
    this.registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Returns the package registry, fetching and validating it if the cache is
   * empty or expired.
   * @returns Validated {@link PackageRegistry} with adapters and extensions.
   * @throws When the fetch fails, the server returns a non-OK status, or the
   *   response body fails schema validation.
   */
  public async getRegistry(): Promise<PackageRegistry> {
    if (this.cache && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      return this.cache.data;
    }

    this.inFlightFetch ??= this.fetchAndCacheRegistry();
    try {
      return await this.inFlightFetch;
    } finally {
      this.inFlightFetch = null;
    }
  }

  /**
   * Fetches, validates, and caches registry data.
   * @returns Validated {@link PackageRegistry}.
   */
  private async fetchAndCacheRegistry(): Promise<PackageRegistry> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      const response = await this.fetchImpl(this.registryUrl, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const registry = PackageRegistrySchema.parse(data);
      this.cache = { data: registry, timestamp: Date.now() };
      return registry;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new Error('Failed to fetch package registry', { cause });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Clears the in-memory cache.
   *
   * Forces the next call to {@link getRegistry} to re-fetch from the registry
   * URL.
   */
  public clearCache(): void {
    this.cache = null;
  }
}
