import { basename } from 'node:path';

const MAX_CACHE_ENTRIES = 512;
const patternRegexCache = new Map<string, RegExp>();
const TOKEN_GLOBSTAR_DIR = '\uE000MAKAIO_GLOBSTAR_DIR\uE001';
const TOKEN_GLOBSTAR = '\uE000MAKAIO_GLOBSTAR\uE001';
const TOKEN_STAR = '\uE000MAKAIO_STAR\uE001';
const MAX_PATTERN_LENGTH = 200;
const MAX_WILDCARDS = 64;

/**
 * Normalize slashes and remove leading current-directory prefixes.
 * @param value - Input path or pattern.
 * @returns A normalized, slash-delimited path string.
 */
function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/^\.\/+/, '');
}

/**
 * Check if a filename matches a glob-like pattern.
 *
 * Supports basic patterns:
 * - `*.ext` - any file with extension
 * - `exact.name` - exact filename match
 * - `**\/path/to/file.ext` - specific filename in any nested path
 * - `**\/dir/*\/file.ext` - filename with wildcard directories
 * - `**\/prefix-*.ext` - filename with wildcard prefix
 *
 * Patterns with path separators are matched against relative paths. Patterns
 * without separators are matched against the basename only.
 * @param relativePath - Relative path from search root (e.g. "foo/bar.json")
 * @param pattern - Pattern to match against
 * @returns True if matches
 */
export function matchesPattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(relativePath);
  const normalizedPattern = normalizePath(pattern);
  const target = normalizedPattern.includes('/') ? normalizedPath : basename(normalizedPath);

  if (normalizedPattern.length > MAX_PATTERN_LENGTH) return false;
  if (!normalizedPattern.includes('*')) return target === normalizedPattern;

  let wildcardCount = 0;
  for (const char of normalizedPattern) {
    if (char !== '*') continue;
    wildcardCount += 1;
    if (wildcardCount > MAX_WILDCARDS) return false;
  }

  const cached = patternRegexCache.get(normalizedPattern);
  if (cached) {
    // Reinsert on hit so Map insertion order tracks recency (LRU behavior).
    patternRegexCache.delete(normalizedPattern);
    patternRegexCache.set(normalizedPattern, cached);
    return cached.test(target);
  }

  const regexSource = normalizedPattern
    .replace(/\*\*\//g, TOKEN_GLOBSTAR_DIR)
    .replace(/\*\*/g, TOKEN_GLOBSTAR)
    .replace(/\*/g, TOKEN_STAR)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll(TOKEN_GLOBSTAR_DIR, '(?:.*/)?')
    .replaceAll(TOKEN_GLOBSTAR, '.*')
    .replaceAll(TOKEN_STAR, '[^/]*');

  const compiled = new RegExp(`^${regexSource}$`);
  if (patternRegexCache.size >= MAX_CACHE_ENTRIES) {
    const iteratorResult = patternRegexCache.keys().next();
    if (!iteratorResult.done) {
      patternRegexCache.delete(iteratorResult.value);
    }
  }
  patternRegexCache.set(normalizedPattern, compiled);
  return compiled.test(target);
}
