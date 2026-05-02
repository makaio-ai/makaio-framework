import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  type IModelRegistryFetcher,
  type ModelRegistry,
  ModelRegistrySchema,
} from '@makaio/services-core/model-registry';
import { formatError, isMissingPathError, isNotDirectoryError } from './fs-utils.js';

/**
 * Fetcher for the bundled seed registry YAML that ships with the app.
 *
 * Always available as the offline/last-resort fallback.
 * Reads the first available YAML file from the configured candidate paths
 * and returns it as a parsed {@link ModelRegistry}. Throws when no candidate
 * exists or when the selected file contains invalid YAML so that a wrapping
 * {@link FallbackRegistryFetcher} can escalate the error rather than silently
 * serving an empty registry.
 * @example
 * ```typescript
 * new BundledSeedFetcher([
 *   path.join(process.resourcesPath, 'static/model-registry.yaml'),
 *   path.join(workspaceRoot, 'static/model-registry.yaml'),
 * ])
 * ```
 */
export class BundledSeedFetcher implements IModelRegistryFetcher {
  private readonly seedPaths: readonly string[];

  /**
   * Creates a new BundledSeedFetcher.
   * @param seedPath - Absolute candidate path(s) to bundled YAML registry files.
   */
  public constructor(seedPath: string | readonly string[]) {
    this.seedPaths = Array.isArray(seedPath) ? seedPath : [seedPath];
  }

  /**
   * Read and parse the bundled seed registry YAML.
   * @returns Parsed model registry.
   * @throws Error if the file does not exist or contains invalid YAML.
   */
  public async fetch(): Promise<ModelRegistry> {
    for (const seedPath of this.seedPaths) {
      const content = await readSeedCandidate(seedPath);
      if (content === undefined) {
        continue;
      }

      try {
        return ModelRegistrySchema.parse(parseYaml(content));
      } catch (error) {
        throw new Error(`Invalid bundled model registry seed at ${seedPath}: ${formatError(error)}`);
      }
    }

    throw new Error(`Bundled model registry seed not found. Tried:\n${this.seedPaths.map((p) => `- ${p}`).join('\n')}`);
  }
}

/**
 * Read a seed candidate path.
 * @param seedPath - Candidate file path.
 * @returns File contents, or undefined when the candidate is absent.
 */
async function readSeedCandidate(seedPath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(seedPath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new Error(`Failed to read bundled model registry seed at ${seedPath}: ${formatError(error)}`);
  }
}

/**
 * Check whether an error represents an absent seed candidate.
 * @param error - Error thrown by `readFile`.
 * @returns Whether the next candidate should be attempted.
 */
function isMissingFileError(error: unknown): boolean {
  return isMissingPathError(error) || isNotDirectoryError(error);
}
