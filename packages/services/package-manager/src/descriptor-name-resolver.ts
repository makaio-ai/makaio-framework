/**
 * Descriptor Name Resolver
 *
 * Maps extension descriptor names to npm package names using the package
 * registry as a lookup table, with scoped passthrough and `@makaio` convention
 * fallbacks.
 * @packageDocumentation
 */
import type { PackageRegistryClient } from './registry-client.js';

/**
 * Resolves extension descriptor names to installable npm package names.
 */
export interface IDescriptorNameResolver {
  /**
   * Resolve a descriptor name to its npm package name.
   *
   * Resolution order:
   * 1. Registry lookup by `descriptorName` field → returns `name`
   * 2. Scoped name (starts with `@`) → pass through as-is
   * 3. Unscoped unmatched name → `@makaio/<descriptorName>` as the final
   *    convention fallback for packages whose descriptor name already includes
   *    its category prefix (for example `provider-anthropic`). The resolver
   *    intentionally does not guess category prefixes such as
   *    `@makaio/extension-${name}`; non-convention mappings belong in the
   *    registry.
   * @param descriptorName - Descriptor name from `descriptor.json` (e.g. `claude-code`)
   * @returns Resolved npm package name (e.g. `@makaio/client-claude-code`)
   */
  resolveNpmPackageName: (descriptorName: string) => Promise<string>;
}

/**
 * Registry-backed implementation of {@link IDescriptorNameResolver}.
 *
 * Fetches the package registry once per instance (caches the promise) and
 * builds a descriptor-name → npm-name lookup map for O(1) resolution.
 */
export class DescriptorNameResolver implements IDescriptorNameResolver {
  private lookupMapPromise: Promise<ReadonlyMap<string, string>> | null = null;

  /**
   * Create a new DescriptorNameResolver.
   * @param registryClient - Client used to fetch the package registry
   */
  public constructor(private readonly registryClient: PackageRegistryClient) {}

  /**
   * Resolve a descriptor name to its npm package name.
   * @param descriptorName - Descriptor name from `descriptor.json`
   * @returns Resolved npm package name
   */
  public async resolveNpmPackageName(descriptorName: string): Promise<string> {
    if (descriptorName.startsWith('@')) {
      return descriptorName;
    }

    let lookupMap: ReadonlyMap<string, string>;
    try {
      lookupMap = await this.getLookupMap();
    } catch (error) {
      throw new Error(`Cannot resolve descriptor name "${descriptorName}": package registry is unavailable`, {
        cause: error,
      });
    }

    const match = lookupMap.get(descriptorName);
    if (match) {
      return match;
    }

    return `@makaio/${descriptorName}`;
  }

  /**
   * Build and cache a descriptor-name → npm-name map from the registry.
   *
   * Failed fetches clear the cached promise so a later resolver call can use
   * explicit registry mappings once the registry becomes available.
   * @returns Cached promise resolving to the lookup map.
   */
  private getLookupMap(): Promise<ReadonlyMap<string, string>> {
    if (this.lookupMapPromise) {
      return this.lookupMapPromise;
    }

    const lookupMapPromise = this.registryClient.getRegistry().then((registry) => {
      const map = new Map<string, string>();
      for (const entry of [...registry.adapters, ...registry.extensions]) {
        if (entry.descriptorName) {
          map.set(entry.descriptorName, entry.name);
        }
      }
      return map;
    });

    const cachedLookupMapPromise = lookupMapPromise.catch((error: unknown) => {
      if (this.lookupMapPromise === cachedLookupMapPromise) {
        this.lookupMapPromise = null;
      }
      throw error;
    });
    this.lookupMapPromise = cachedLookupMapPromise;
    return this.lookupMapPromise;
  }
}
