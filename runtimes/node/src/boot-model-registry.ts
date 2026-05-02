import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CachedRegistryFetcher,
  FallbackRegistryFetcher,
  type IModelRegistryFetcher,
} from '@makaio/services-core/model-registry';
import { BundledSeedFetcher } from './model-registry/bundled-seed-fetcher.js';
import { CdnRegistryFetcher } from './model-registry/cdn-registry-fetcher.js';
import { FileRegistryCache } from './model-registry/file-registry-cache.js';
import { UserOverlayFetcher } from './model-registry/user-overlay-fetcher.js';
import { findWorkspaceRoot, WorkspaceRootNotFoundError } from './find-workspace-root.js';

/** Environment override for ordered model-registry base sources. */
export const MAKAIO_MODEL_REGISTRY_SOURCES_ENV = 'MAKAIO_MODEL_REGISTRY_SOURCES';

/**
 * Official framework model registry published from the model-catalog pipeline.
 *
 * Hosts may override this URL, but the framework owns a default catalog source
 * so normal boot does not require host-specific configuration.
 */
const DEFAULT_CDN_REGISTRY_URL = 'https://makaio-ai.github.io/makaio-framework/model-registry.yaml';

/** Dependencies for assembling the boot-time model registry fetcher chain. */
export interface BootModelRegistryFetcherOptions {
  /** Makaio home directory for user overrides and registry cache. */
  readonly makaioHome: string;
  /** Directory of the compiled boot module. */
  readonly srcDir: string;
  /** Optional hosted YAML registry URL override. */
  readonly cdnRegistryUrl?: string;
  /** Optional local seed candidates inserted before default dev/packaged seeds. */
  readonly seedPaths?: readonly string[];
  /** Optional packaged seed candidates inserted after the CDN cache source. */
  readonly fallbackSeedPaths?: readonly string[];
  /** Environment snapshot used for {@link MAKAIO_MODEL_REGISTRY_SOURCES_ENV}. */
  readonly env?: NodeJS.ProcessEnv;
  /** Current working directory used for dev seed lookup. */
  readonly cwd?: string;
}

/**
 * Create the boot-time model registry fetcher chain.
 *
 * Lookup order:
 * 1. User overlay directory (`<makaioHome>/models`) — applied on top of the
 *    resolved base registry; never used as a fallback.
 * 2. `MAKAIO_MODEL_REGISTRY_SOURCES` entries, in declared order.
 * 3. Explicit local seeds and dev workspace seed.
 * 4. Official framework CDN registry, cached per source URL.
 * 5. Host-provided packaged fallback seeds and boot-relative seed.
 * @param options - Boot-time registry paths, CDN URL, and environment.
 * @returns Model registry fetcher used by the framework model-registry package.
 */
export function createBootModelRegistryFetcher(options: BootModelRegistryFetcherOptions): IModelRegistryFetcher {
  const userModelsDir = path.join(options.makaioHome, 'models');
  const cacheDir = path.join(options.makaioHome, 'cache', 'model-registry');
  const baseSources = collectRegistrySources(options);

  return new UserOverlayFetcher(
    userModelsDir,
    new FallbackRegistryFetcher(baseSources.map((source) => createSourceFetcher(source, cacheDir))),
  );
}

/**
 * Collect and deduplicate ordered model-registry base sources.
 * @param options - Boot-time registry source options.
 * @returns Ordered sources with env entries before framework defaults.
 */
function collectRegistrySources(options: BootModelRegistryFetcherOptions): string[] {
  const defaultSeedPaths = resolveBundledSeedPaths(options.srcDir, options.cwd);
  const localSeedPaths = defaultSeedPaths.slice(0, -1);
  const bootSeedPaths = defaultSeedPaths.slice(localSeedPaths.length);

  return dedupeSources([
    ...parseEnvironmentSources(options.env ?? process.env),
    ...(options.seedPaths ?? []),
    ...localSeedPaths,
    options.cdnRegistryUrl ?? DEFAULT_CDN_REGISTRY_URL,
    ...(options.fallbackSeedPaths ?? []),
    ...bootSeedPaths,
  ]);
}

/**
 * Parse `MAKAIO_MODEL_REGISTRY_SOURCES`.
 *
 * The value may be a JSON string array for ordered multi-source overrides, or
 * a single source string for simple local testing.
 * @param env - Environment snapshot.
 * @returns Ordered sources declared by the environment.
 */
function parseEnvironmentSources(env: NodeJS.ProcessEnv): string[] {
  const raw = env[MAKAIO_MODEL_REGISTRY_SOURCES_ENV]?.trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = raw.startsWith('[') ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(
      `[boot] ${MAKAIO_MODEL_REGISTRY_SOURCES_ENV} must be a JSON string array or a single source string`,
      { cause: error },
    );
  }

  const sources = Array.isArray(parsed) ? parsed : [parsed];
  if (!sources.every((source): source is string => typeof source === 'string')) {
    throw new Error(`[boot] ${MAKAIO_MODEL_REGISTRY_SOURCES_ENV} entries must be strings`);
  }
  return sources.map((source) => source.trim()).filter((source) => source.length > 0);
}

/**
 * Resolve the default bundled seed YAML candidates.
 *
 * CWD and workspace-root probing are the dev-authoring paths for generated seed YAML.
 * Packaged/framework-only boot often has no workspace root, so that expected
 * case falls through silently to the boot-relative seed candidate.
 * @param srcDir - Directory of the compiled boot module.
 * @param cwd - Current working directory used for repo-root dev seed lookup.
 * @returns Ordered local seed YAML candidates.
 */
export function resolveBundledSeedPaths(srcDir: string, cwd = process.cwd()): readonly string[] {
  const bootSeed = path.resolve(srcDir, 'static/model-registry.yaml');
  const cwdSeed = path.resolve(cwd, 'static/model-registry.yaml');
  try {
    return dedupeSources([cwdSeed, path.resolve(findWorkspaceRoot(srcDir), 'static/model-registry.yaml'), bootSeed]);
  } catch (error) {
    if (error instanceof WorkspaceRootNotFoundError) {
      return dedupeSources([cwdSeed, bootSeed]);
    }
    throw error;
  }
}

/**
 * Create a fetcher for one source entry.
 * @param source - HTTP(S), file URL, absolute path, or cwd-relative path.
 * @param cacheDir - Directory for per-URL cache files.
 * @returns Fetcher for the source.
 */
function createSourceFetcher(source: string, cacheDir: string): IModelRegistryFetcher {
  const url = parseSourceUrl(source);
  if (url?.protocol === 'http:' || url?.protocol === 'https:') {
    return new CachedRegistryFetcher(
      new CdnRegistryFetcher(url.href),
      new FileRegistryCache(path.join(cacheDir, `${hashSource(url.href)}.json`), { trackFetchedAt: true }),
    );
  }

  return new BundledSeedFetcher(resolveSourcePath(source, url));
}

/**
 * Resolve a source into a local filesystem path.
 * @param source - Raw source entry.
 * @param url - Parsed URL when the entry is URL-shaped.
 * @returns Absolute local file path.
 */
function resolveSourcePath(source: string, url: URL | undefined): string {
  if (url?.protocol === 'file:') {
    return fileURLToPath(url);
  }
  if (url !== undefined) {
    throw new Error(`[boot] Unsupported model registry source protocol "${url.protocol}" for ${source}`);
  }
  return path.isAbsolute(source) ? source : path.resolve(source);
}

/**
 * Parse URL-shaped sources while leaving plain paths untouched.
 * @param source - Raw source entry.
 * @returns Parsed URL, or `undefined` for plain paths.
 */
function parseSourceUrl(source: string): URL | undefined {
  try {
    return new URL(source);
  } catch {
    return undefined;
  }
}

/**
 * Deduplicate sources after normalizing URL and path identity.
 * @param sources - Ordered raw sources.
 * @returns First occurrence of each distinct source.
 */
function dedupeSources(sources: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

/**
 * Build a stable source identity for deduplication.
 * @param source - Raw source entry.
 * @returns Normalized identity key.
 */
function sourceKey(source: string): string {
  const url = parseSourceUrl(source);
  if (url?.protocol === 'file:') {
    return `file:${path.resolve(fileURLToPath(url))}`;
  }
  if (url !== undefined) {
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  }
  return `file:${path.resolve(source)}`;
}

/**
 * Hash a source string for a filesystem-safe cache filename.
 * @param source - URL source.
 * @returns Short SHA-256 hash.
 */
function hashSource(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}
