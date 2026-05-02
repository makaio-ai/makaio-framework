/**
 * Install source parsing.
 *
 * Resolves a raw CLI source string (npm package name, local path, or git URL)
 * into a typed {@link InstallSource} with a detected kind and normalized form.
 * @packageDocumentation
 */

import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Resolved install source with detected kind.
 */
export interface InstallSource {
  /** Source type: npm registry, local path, or git URL. */
  readonly kind: 'npm' | 'local' | 'git';
  /** Original source string as provided by the user. */
  readonly raw: string;
  /** Resolved/normalized form of the source. For local paths this is the absolute path. */
  readonly resolved: string;
}

/**
 * Parse a CLI source string into a typed install source.
 *
 * Detection rules (applied in order):
 * 1. `git+` prefix → `'git'`
 * 2. relative, absolute, or home-relative path → `'local'` (path resolved to absolute)
 * 3. Everything else → `'npm'`
 * @param source - Raw source string from CLI argument (e.g. `'./my-ext'`,
 *   `'@acme/weather-tools@1.2.0'`, `'git+https://github.com/acme/tools.git'`).
 * @returns Parsed install source with kind and resolved path or package name.
 */
export function parseInstallSource(source: string): InstallSource {
  if (source.startsWith('git+')) {
    return { kind: 'git', raw: source, resolved: source };
  }

  const isHomeRelative = source === '~' || source.startsWith('~/') || source.startsWith('~\\');
  if (source.startsWith('~') && !isHomeRelative) {
    throw new Error(`Unsupported home-relative path syntax: ${source}`);
  }

  if (source.startsWith('.') || path.isAbsolute(source) || path.win32.isAbsolute(source) || isHomeRelative) {
    const resolved = isHomeRelative
      ? path.resolve(os.homedir(), source === '~' ? '.' : source.slice(2))
      : path.resolve(source);
    return { kind: 'local', raw: source, resolved };
  }

  return { kind: 'npm', raw: source, resolved: source };
}
