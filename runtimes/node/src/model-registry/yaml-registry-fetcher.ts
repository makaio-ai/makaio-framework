import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type IModelRegistryFetcher,
  type ModelRegistry,
  ModelRegistrySchema,
} from '@makaio/services-core/model-registry';
import { listYamlFiles } from './fs-utils.js';
import { parseLabFile, parseProviderFile } from './directory-registry-overlay-fetcher.js';

const YAML_REGISTRY_UPDATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Fetcher that loads model registry data from YAML files in `labs/` and
 * `providers/` subdirectories.
 *
 * Each YAML file in `labsDir` is treated as one lab entry keyed by its
 * basename (without `.yaml`). Each YAML file in `providersDir` is treated
 * as one provider entry in the same way. Missing directories are treated as
 * empty. Other directory read failures throw so configuration errors are not
 * mistaken for a valid empty registry.
 * @example
 * ```typescript
 * const fetcher = new YamlRegistryFetcher(
 *   path.join(workspaceRoot, 'providers/labs'),
 *   path.join(workspaceRoot, 'providers/providers'),
 * );
 * const registry = await fetcher.fetch();
 * ```
 */
export class YamlRegistryFetcher implements IModelRegistryFetcher {
  /**
   * Creates a new YamlRegistryFetcher.
   * @param labsDir - Absolute path to the directory containing lab YAML files.
   * @param providersDir - Absolute path to the directory containing provider YAML files.
   */
  public constructor(
    private readonly labsDir: string,
    private readonly providersDir: string,
  ) {}

  /**
   * Load labs and providers from YAML files and assemble a v2 ModelRegistry.
   * @returns A fully-assembled v2 model registry.
   */
  public async fetch(): Promise<ModelRegistry> {
    const [labs, providers] = await Promise.all([this.loadLabs(), this.loadProviders()]);
    return ModelRegistrySchema.parse({
      $schema: 'makaio/model-registry/v2',
      updatedAt: YAML_REGISTRY_UPDATED_AT,
      labs,
      providers,
    });
  }

  /**
   * Load all lab entries from YAML files in `labsDir`.
   * @returns Partial registry labs map.
   */
  private async loadLabs(): Promise<ModelRegistry['labs']> {
    const files = await listYamlFiles(this.labsDir);
    const entries = await Promise.all(
      files.map(async (file) => {
        const labId = path.basename(file, '.yaml');
        const content = await fs.promises.readFile(file, 'utf-8');
        const lab = parseLabFile(parseYaml(content), labId);
        return [labId, { ...lab, name: lab.name ?? labId }] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  /**
   * Load all provider entries from YAML files in `providersDir`.
   * @returns Partial registry providers map.
   */
  private async loadProviders(): Promise<ModelRegistry['providers']> {
    const files = await listYamlFiles(this.providersDir);
    const entries = await Promise.all(
      files.map(async (file) => {
        const providerId = path.basename(file, '.yaml');
        const content = await fs.promises.readFile(file, 'utf-8');
        const provider = parseProviderFile(parseYaml(content));
        return [providerId, { ...provider, name: provider.name ?? providerId }] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
}
