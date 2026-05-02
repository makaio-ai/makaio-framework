import * as fs from 'node:fs';
import type { IModelRegistryFetcher, ModelRegistry } from '@makaio/services-core/model-registry';

/**
 * Reads a model registry from a local JSON file.
 *
 * Throws on any failure (file missing, unreadable, or invalid JSON) so that
 * a wrapping {@link FallbackRegistryFetcher} can advance to the next source.
 * @example
 * ```typescript
 * const fetcher = new FileRegistryFetcher('~/.makaio/model-registry.json');
 * const registry = await fetcher.fetch();
 * ```
 */
export class FileRegistryFetcher implements IModelRegistryFetcher {
  /**
   * Creates a new FileRegistryFetcher.
   * @param filePath - Absolute path to the JSON registry file.
   */
  public constructor(private readonly filePath: string) {}

  /**
   * Read and parse the registry file.
   * @returns Parsed registry data
   * @throws Error if the file does not exist, is unreadable, or contains invalid JSON
   */
  public async fetch(): Promise<ModelRegistry> {
    const content = await fs.promises.readFile(this.filePath, 'utf-8');
    return JSON.parse(content) as ModelRegistry;
  }
}
