import type { PackageRegistry } from './schemas.js';

/**
 * Package registry client interface.
 */
export interface PackageRegistryClient {
  /**
   * Fetch package registry data.
   * @returns Validated package registry.
   */
  getRegistry: () => Promise<PackageRegistry>;
}
