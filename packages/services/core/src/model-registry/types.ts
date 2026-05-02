import type { ModelRegistry } from './schemas.js';

// ---------------------------------------------------------------------------
// Cache and fetcher interfaces
// ---------------------------------------------------------------------------

/**
 * Storage interface for model registry cache persistence.
 *
 * Allows for different implementations across environments:
 * - Browser: localStorage
 * - Node.js: File system cache
 * - Testing: In-memory cache
 * @example Browser localStorage implementation
 * ```typescript
 * class LocalStorageRegistryCache implements IModelRegistryCache {
 *   async get(): Promise<ModelRegistry | null> {
 *     const data = localStorage.getItem('makaio:model-registry');
 *     return data ? JSON.parse(data) : null;
 *   }
 *
 *   async set(registry: ModelRegistry): Promise<void> {
 *     localStorage.setItem('makaio:model-registry', JSON.stringify(registry));
 *   }
 * }
 * ```
 * @example Node.js file-based implementation
 * ```typescript
 * class FileRegistryCache implements IModelRegistryCache {
 *   async get(): Promise<ModelRegistry | null> {
 *     try {
 *       const content = await fs.readFile('~/.makaio/cache/model-registry.json', 'utf-8');
 *       return JSON.parse(content);
 *     } catch {
 *       return null;
 *     }
 *   }
 *
 *   async set(registry: ModelRegistry): Promise<void> {
 *     await fs.writeFile('~/.makaio/cache/model-registry.json', JSON.stringify(registry));
 *   }
 * }
 * ```
 */
export interface IModelRegistryCache {
  /**
   * Get the cached model registry.
   * @returns The cached registry, or null if not cached
   */
  get(): Promise<ModelRegistry | null>;

  /**
   * Save the model registry to cache.
   * @param registry - The registry to cache
   */
  set(registry: ModelRegistry): Promise<void>;
}

/**
 * Interface for fetching the model registry from a source.
 *
 * Allows for different fetch implementations:
 * - CDN/HTTP fetch (browser/Node)
 * - Local YAML files
 * - Bundled seed
 * - Testing: Mock fetch
 * @example CDN fetch implementation
 * ```typescript
 * class CdnRegistryFetcher implements IModelRegistryFetcher {
 *   constructor(private readonly registryUrl: string) {}
 *
 *   async fetch(): Promise<ModelRegistry> {
 *     const response = await fetch(this.registryUrl);
 *     if (!response.ok) {
 *       throw new Error(`Failed to fetch registry: ${response.statusText}`);
 *     }
 *     return parseYaml(await response.text()) as ModelRegistry;
 *   }
 * }
 * ```
 */
export interface IModelRegistryFetcher {
  /**
   * Fetch the model registry from a source.
   *
   * Implementations MUST return the result of `ModelRegistrySchema.parse()` —
   * i.e., a fully validated {@link ModelRegistry}. The service layer trusts
   * the returned value directly and does not re-validate it, so schema
   * validation (including the `superRefine` cross-validation) is the
   * responsibility of the fetcher implementation.
   * @returns The validated model registry
   * @throws Error if fetch fails or schema validation fails
   */
  fetch(): Promise<ModelRegistry>;
}
