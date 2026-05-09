import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type IModelRegistryCache,
  type ModelRegistry,
  ModelRegistrySchema,
} from '@makaio/services-core/model-registry';
import { isRecord } from '@makaio/utils';

/**
 * Options for file-backed registry cache persistence.
 */
export interface FileRegistryCacheOptions {
  /**
   * Persist an ISO timestamp next to the registry payload.
   *
   * The read contract still returns only the registry; the timestamp is a
   * persistence seam for future TTL policy.
   */
  readonly trackFetchedAt?: boolean;
}

interface RegistryCacheEnvelope {
  readonly fetchedAt: string;
  readonly registry: ModelRegistry;
}

/**
 * File-based model registry cache for Node.js.
 *
 * Persists the model registry as JSON at `<cachePath>`.
 * Silently returns null on read errors (cache miss) and logs warnings on
 * write errors (non-fatal, in-memory data still serves requests).
 */
export class FileRegistryCache implements IModelRegistryCache {
  private readonly cachePath: string;
  private readonly trackFetchedAt: boolean;

  /**
   * Creates a new FileRegistryCache.
   * @param cachePath - Absolute path to the cache file (e.g. `~/.makaio/cache/model-registry.json`)
   * @param options - Cache persistence options.
   */
  public constructor(cachePath: string, options: FileRegistryCacheOptions = {}) {
    this.cachePath = cachePath;
    this.trackFetchedAt = options.trackFetchedAt ?? false;
  }

  /**
   * Read cached registry from disk.
   * @returns Parsed registry or null if file missing or corrupt
   */
  public async get(): Promise<ModelRegistry | null> {
    try {
      const content = await fs.promises.readFile(this.cachePath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      const candidate = readCachedRegistry(parsed);
      const result = ModelRegistrySchema.safeParse(candidate);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Write registry to disk cache.
   * Creates parent directories if they don't exist.
   * @param registry - Registry data to persist
   */
  public async set(registry: ModelRegistry): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.cachePath), { recursive: true });
      const payload: ModelRegistry | RegistryCacheEnvelope = this.trackFetchedAt
        ? { fetchedAt: new Date().toISOString(), registry }
        : registry;
      await fs.promises.writeFile(this.cachePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[FileRegistryCache] Failed to write cache:', err);
    }
  }
}

/**
 * Extract the registry from either the legacy raw cache shape or the timestamped envelope.
 * @param parsed - Parsed JSON cache payload.
 * @returns Candidate registry payload.
 */
function readCachedRegistry(parsed: unknown): unknown {
  if (!isRecord(parsed)) {
    return parsed;
  }

  if ('registry' in parsed && 'fetchedAt' in parsed) {
    return parsed.registry;
  }

  return parsed;
}
