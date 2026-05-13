import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { DEFAULT_DENIED_PATTERNS } from './default-patterns.js';
import type { FileAccessRuleProvider, FileAccessRules } from '../types.js';

type IgnoreMatcher = ReturnType<typeof ignore>;

/** Cached patterns for a single .makaioignore file. */
interface CachedLayer {
  /** Raw lines from the file, ready for the `ignore` package. */
  readonly patterns: string[];
  /** Last-modified timestamp in milliseconds. */
  readonly mtime: number;
  /** Compiled matcher for this layer only. */
  readonly matcher: IgnoreMatcher;
}

/** Cached compiled rules for a cwd, keyed by composite mtime fingerprint. */
interface CachedRules {
  /** Fingerprint: sorted file paths with their mtimes. */
  readonly fingerprint: string;
  /** Compiled deny predicate. */
  readonly isDenied: (absolutePath: string) => boolean;
}

/** Maximum entries retained in each in-memory provider cache. */
const MAX_CACHE_ENTRIES = 256;

/** Options for {@link createMakaioIgnoreProvider}. */
export interface MakaioIgnoreProviderOptions {
  /**
   * Path to the global ignore file (e.g. `~/.makaio/.makaioignore`).
   * Set to `null` to disable global ignore loading.
   */
  readonly globalIgnorePath: string | null;
}

/** Collected .makaioignore data for one directory level. */
interface IgnoreLayer {
  /** Absolute path to the directory containing this .makaioignore. */
  readonly dir: string;
  /** Absolute path to the .makaioignore file. */
  readonly filePath: string;
  /** Last-modified timestamp in milliseconds. */
  readonly mtime: number;
  /** Raw lines to add to the ignore instance. */
  readonly patterns: string[];
  /** Compiled matcher for this layer only. */
  readonly matcher: IgnoreMatcher;
}

/**
 * Convert an OS-native path to the slash format expected by `ignore`.
 * @param value - Relative path
 * @returns Slash-normalized path
 */
function toIgnorePath(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Check whether `path.relative(cwd, target)` points outside cwd.
 * @param relativePath - Relative path from cwd to target
 * @returns True when target is outside cwd
 */
function isOutsideCwd(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath.startsWith('../') ||
    path.isAbsolute(relativePath)
  );
}

/**
 * Load a .makaioignore layer from cache or filesystem.
 * @param filePath - Absolute path to .makaioignore file
 * @param cache - Shared cache keyed by file path
 * @returns Cached layer, or undefined when file does not exist
 */
async function loadOrRefreshLayer(filePath: string, cache: Map<string, CachedLayer>): Promise<CachedLayer | undefined> {
  try {
    const stats = await stat(filePath);
    const mtime = stats.mtimeMs;
    const cached = getCached(cache, filePath);
    if (cached !== undefined && cached.mtime === mtime) {
      return cached;
    }

    const text = await readFile(filePath, 'utf8');
    const patterns = text.split('\n').map((line) => line.replace(/\r$/, ''));
    const matcher = ignore().add(patterns);
    const refreshed = { patterns, mtime, matcher };
    setCached(cache, filePath, refreshed);
    return refreshed;
  } catch (err: unknown) {
    if (!isEnoent(err)) {
      throw err;
    }
    return undefined;
  }
}

/**
 * Walk from `cwd` up to the filesystem root collecting `.makaioignore` files.
 * Results are ordered root → cwd (closest to root first).
 * @param cwd - Absolute working directory to start from
 * @param cache - Mutable cache keyed by absolute `.makaioignore` file path
 * @returns Layers ordered from root to cwd
 */
async function collectIgnoreLayers(cwd: string, cache: Map<string, CachedLayer>): Promise<IgnoreLayer[]> {
  const layers: IgnoreLayer[] = [];
  let dir = cwd;

  // Walk upward until the directory no longer changes (we've hit the root).
  while (true) {
    const filePath = path.join(dir, '.makaioignore');
    const layer = await loadOrRefreshLayer(filePath, cache);
    if (layer !== undefined) {
      layers.push({ dir, filePath, mtime: layer.mtime, patterns: layer.patterns, matcher: layer.matcher });
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached the filesystem root.
      break;
    }
    dir = parent;
  }

  // Collected in cwd-to-root order; reverse to get root-to-cwd order.
  return layers.reverse();
}

/**
 * Load the global ignore file if it exists.
 * @param globalPath - Absolute path to the global ignore file
 * @param cache - Shared layer cache (keyed by absolute file path)
 * @returns The loaded layer, or `null` if the file does not exist
 */
async function loadGlobalIgnoreLayer(globalPath: string, cache: Map<string, CachedLayer>): Promise<IgnoreLayer | null> {
  const layer = await loadOrRefreshLayer(globalPath, cache);
  if (layer === undefined) {
    return null;
  }
  return {
    dir: path.dirname(globalPath),
    filePath: globalPath,
    mtime: layer.mtime,
    patterns: layer.patterns,
    matcher: layer.matcher,
  };
}

/**
 * Build a deny predicate from collected ignore layers.
 *
 * Precedence (last writer wins): defaults → global → hierarchical (root → cwd).
 * @param cwd - Absolute working directory (used for relative path computation)
 * @param layers - Ignore layers ordered root → cwd
 * @param globalLayer - Optional global ignore layer (`~/.makaio/.makaioignore`)
 * @returns A synchronous predicate that returns `true` if the path is denied
 */
function buildDenyPredicate(
  cwd: string,
  layers: IgnoreLayer[],
  globalLayer: IgnoreLayer | null,
): (absolutePath: string) => boolean {
  const defaultMatcher = ignore().add([...DEFAULT_DENIED_PATTERNS]);
  const layerMatchers = layers.map((layer) => ({
    matcher: layer.matcher,
    cwdFromLayer: path.relative(layer.dir, cwd),
  }));

  return (absolutePath: string): boolean => {
    const relFromCwd = path.relative(cwd, absolutePath);
    // rel === '' means absolutePath is exactly cwd — not a file, skip.
    // outside cwd paths are governed by allowedDirectories only.
    if (relFromCwd === '' || isOutsideCwd(relFromCwd)) {
      return false;
    }

    const relForDefault = toIgnorePath(relFromCwd);
    let denied = defaultMatcher.ignores(relForDefault);

    // Global ignore: applied after defaults, before hierarchical layers.
    // Patterns are cwd-relative (not directory-scoped) like defaults.
    if (globalLayer !== null) {
      const result = globalLayer.matcher.test(relForDefault);
      if (result.unignored) {
        denied = false;
      } else if (result.ignored) {
        denied = true;
      }
    }

    for (const { matcher, cwdFromLayer } of layerMatchers) {
      const relFromLayer = cwdFromLayer.length > 0 ? toIgnorePath(path.join(cwdFromLayer, relFromCwd)) : relForDefault;
      const result = matcher.test(relFromLayer);
      if (result.unignored) {
        denied = false;
      } else if (result.ignored) {
        denied = true;
      }
    }

    return denied;
  };
}

/**
 * Narrow an unknown error to one with a `code` property.
 * @param err - The caught value
 * @returns `true` if the error has `code === 'ENOENT'`
 */
function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'ENOENT';
}

/**
 * Read from an insertion-ordered cache and refresh recency.
 * @param cache - Cache map
 * @param key - Entry key
 * @returns Cached value if present
 */
function getCached<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) {
    return undefined;
  }
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/**
 * Insert into an insertion-ordered cache and evict oldest entries when needed.
 * @param cache - Cache map
 * @param key - Entry key
 * @param value - Entry value
 */
function setCached<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

/**
 * Create a `FileAccessRuleProvider` that reads `.makaioignore` files from
 * the working directory up to the filesystem root, loads the global ignore
 * file specified in `options.globalIgnorePath`, and applies a default set of deny patterns.
 *
 * Precedence (last writer wins): defaults → global → hierarchical (root → cwd).
 *
 * The provider caches each file by `mtimeMs` so repeated calls within a
 * session are cheap. Changes on disk are detected automatically on the next
 * call.
 * @param options - Configuration for the provider, including the global ignore path
 * @returns A `FileAccessRuleProvider` function
 */
export function createMakaioIgnoreProvider(options: MakaioIgnoreProviderOptions): FileAccessRuleProvider {
  const { globalIgnorePath } = options;
  const layerCache = new Map<string, CachedLayer>();
  const rulesCache = new Map<string, CachedRules>();

  return async (cwd: string, allowedDirectories?: readonly string[]): Promise<FileAccessRules> => {
    const [layers, globalLayer] = await Promise.all([
      collectIgnoreLayers(cwd, layerCache),
      globalIgnorePath !== null ? loadGlobalIgnoreLayer(globalIgnorePath, layerCache) : Promise.resolve(null),
    ]);

    // Build fingerprint from global + all discovered .makaioignore mtimes.
    const globalFingerprint = globalLayer !== null ? `${globalLayer.filePath}:${globalLayer.mtime}|` : '';
    const fingerprint = globalFingerprint + layers.map((layer) => `${layer.filePath}:${layer.mtime}`).join('|');

    const cached = getCached(rulesCache, cwd);
    let isDenied: (absolutePath: string) => boolean;

    if (cached !== undefined && cached.fingerprint === fingerprint) {
      isDenied = cached.isDenied;
    } else {
      isDenied = buildDenyPredicate(cwd, layers, globalLayer);
      setCached(rulesCache, cwd, { fingerprint, isDenied });
    }

    return {
      ...(allowedDirectories !== undefined && { allowedDirectories: [...allowedDirectories] }),
      isDenied,
    };
  };
}
