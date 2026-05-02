import * as fs from 'node:fs/promises';
import { ModelRegistrySchema } from '@makaio/services-core/model-registry';
import type { IModelRegistryFetcher, ModelRegistry } from '@makaio/services-core/model-registry';
import { DirectoryRegistryOverlayFetcher, mergeRegistryOverlay } from './directory-registry-overlay-fetcher.js';
import { listYamlFiles, isMissingPathError } from './fs-utils.js';

/**
 * Fetcher that applies user-authored YAML overlays on top of a base registry.
 *
 * The overlay directory is scanned for YAML files in the same formats as
 * {@link DirectoryRegistryOverlayFetcher}. If the overlay directory is absent
 * or empty, the base registry is returned unchanged.
 *
 * Unlike {@link DirectoryRegistryFetcher}, provider model references are
 * validated against the merged (base + overlay) model set, so user overlays
 * can extend the base lab models without declaring them locally.
 * @example
 * ```typescript
 * const fetcher = new UserOverlayFetcher(
 *   path.join(makaioHome, 'models'),
 *   new FallbackRegistryFetcher([cdnFetcher, seedFetcher]),
 * );
 * const registry = await fetcher.fetch();
 * ```
 */
export class UserOverlayFetcher implements IModelRegistryFetcher {
  /**
   * Creates a new UserOverlayFetcher.
   * @param userModelsDir - Absolute path to the user models overlay directory.
   * @param baseFetcher - Fetcher for the base registry to overlay onto.
   */
  public constructor(
    private readonly userModelsDir: string,
    private readonly baseFetcher: IModelRegistryFetcher,
  ) {}

  /**
   * Fetch the base registry and apply user overlays from the configured directory.
   *
   * If the overlay directory is absent or empty, returns the base registry unchanged.
   * @returns Merged and validated model registry
   * @throws Error if the base fetcher fails or the overlay YAML is invalid
   */
  public async fetch(): Promise<ModelRegistry> {
    const baseRegistry = await this.baseFetcher.fetch();

    // Validate that the root directory is either absent or a real directory
    await this.validateDirectory(this.userModelsDir);

    // Validate labs/ and providers/ sub-paths when they exist
    await this.validateDirectory(`${this.userModelsDir}/labs`);
    await this.validateDirectory(`${this.userModelsDir}/providers`);

    const hasFiles = await this.hasAnyOverlayFiles();
    if (!hasFiles) {
      return baseRegistry;
    }

    const overlayFetcher = new DirectoryRegistryOverlayFetcher(this.userModelsDir);
    const overlay = await overlayFetcher.fetch();
    const merged = mergeRegistryOverlay(baseRegistry, overlay);
    return ModelRegistrySchema.parse(merged);
  }

  /**
   * Validate that a path is absent or is a real directory.
   *
   * Uses `listYamlFiles` to trigger the ENOTDIR check — it throws a descriptive
   * error when the path exists but is not a directory.
   * @param dirPath - Path to validate.
   * @throws Error when the path exists but is not a directory.
   */
  private async validateDirectory(dirPath: string): Promise<void> {
    await listYamlFiles(dirPath);
  }

  /**
   * Check whether the overlay directory contains any YAML files or
   * recognised sub-directories.
   * @returns Whether any overlay content was found.
   */
  private async hasAnyOverlayFiles(): Promise<boolean> {
    let names: string[];
    let stats: Map<string, boolean[]>;
    try {
      const entries = await fs.readdir(this.userModelsDir, { withFileTypes: true });
      names = entries.map((e) => String(e.name));
      stats = new Map(entries.map((e) => [String(e.name), [e.isFile(), e.isDirectory()]]));
    } catch (error) {
      if (isMissingPathError(error)) {
        return false;
      }
      throw error;
    }

    return names.some((name) => {
      const [isFile, isDir] = stats.get(name) ?? [false, false];
      return (isFile && name.endsWith('.yaml')) || (isDir && (name === 'labs' || name === 'providers'));
    });
  }
}
