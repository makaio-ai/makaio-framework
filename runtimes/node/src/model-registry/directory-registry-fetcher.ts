import { ModelRegistrySchema } from '@makaio/services-core/model-registry';
import type { IModelRegistryFetcher, ModelRegistry } from '@makaio/services-core/model-registry';
import { DirectoryRegistryOverlayFetcher, overlayToRegistry } from './directory-registry-overlay-fetcher.js';

const UNKNOWN_DIRECTORY_REGISTRY_UPDATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Standalone registry fetcher that loads model data from a directory of YAML files.
 *
 * Unlike {@link DirectoryRegistryOverlayFetcher}, this fetcher produces a
 * self-contained registry and validates it against {@link ModelRegistrySchema},
 * including cross-provider reference checks. This means all provider model
 * references must resolve to a lab model in the same directory.
 *
 * Use {@link DirectoryRegistryOverlayFetcher} instead when loading user
 * customizations that extend a base registry supplied by another source.
 * @example
 * ```typescript
 * const fetcher = new DirectoryRegistryFetcher(path.join(workspaceRoot, 'user-models'));
 * const registry = await fetcher.fetch();
 * ```
 */
export class DirectoryRegistryFetcher implements IModelRegistryFetcher {
  private readonly overlayFetcher: DirectoryRegistryOverlayFetcher;

  /**
   * Creates a new DirectoryRegistryFetcher.
   * @param userModelsDir - Absolute path to the directory containing YAML files.
   */
  public constructor(private readonly userModelsDir: string) {
    this.overlayFetcher = new DirectoryRegistryOverlayFetcher(userModelsDir);
  }

  /**
   * Load the overlay from the directory and validate as a standalone registry.
   *
   * Throws a schema validation error when provider model references cannot be
   * resolved to a lab model within the same directory.
   * @returns Validated model registry
   * @throws Error if YAML files are invalid or provider references cannot be resolved
   */
  public async fetch(): Promise<ModelRegistry> {
    const overlay = await this.overlayFetcher.fetch();
    const candidate = overlayToRegistry(overlay, UNKNOWN_DIRECTORY_REGISTRY_UPDATED_AT);
    return ModelRegistrySchema.parse(candidate);
  }
}
