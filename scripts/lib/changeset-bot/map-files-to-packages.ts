/**
 * Maps changed file paths (relative to the framework repo root) to the npm
 * package names they belong to.
 *
 * CodeRabbit paths are display strings, not package identifiers. This mapper
 * only emits package names read from real `package.json` files, plus the
 * explicit `@makaio/framework` fallback for framework-wide infrastructure.
 *
 * Direct package roots:
 * - `core/contracts/`
 * - `packages/framework/`
 * - `adapters/implementations/<name>/`
 * - `clients/<name>/`
 * - `providers/<name>/`
 * - `extensions/<name>/`
 * - `sdks/typescript/`
 *
 * Non-package framework infrastructure maps to `@makaio/framework`. CodeRabbit
 * placeholder paths such as `clients/...` are ignored.
 * @packageDocumentation
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** Directory prefixes that are never part of a publishable package. */
const NON_PUBLISHABLE_PREFIXES = ['.github/', 'docs/'] as const;
const FRAMEWORK_PACKAGE = '@makaio/framework';

/** Options for package mapping. */
export interface MapFilesToPackagesOptions {
  /** Framework repository root used to resolve real package manifests. */
  readonly frameworkRoot?: string;
}

/** Minimal package manifest fields needed by the mapper. */
interface PackageManifest {
  readonly name: string;
}

/**
 * Tests whether a parsed JSON value is a package manifest with a string name.
 * @param value - Parsed JSON value.
 * @returns True when the value contains a package name.
 */
function isPackageManifest(value: unknown): value is PackageManifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof (value as { readonly name: unknown }).name === 'string'
  );
}

/**
 * Reads a package name from a `package.json` file.
 * @param packageJsonPath - Absolute package manifest path.
 * @returns Package name, or `undefined` if the file cannot be read.
 */
function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return isPackageManifest(parsed) ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the path directory to start package lookup from.
 * @param frameworkRoot - Absolute framework root.
 * @param file - Framework-root-relative file or directory path.
 * @returns Absolute directory path.
 */
function resolveLookupDirectory(frameworkRoot: string, file: string): string {
  const absolute = resolve(frameworkRoot, file);
  if (!existsSync(absolute)) {
    return dirname(absolute);
  }
  return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
}

/**
 * Tests whether a package root should appear directly in a changeset.
 * @param packageDir - Package directory relative to the framework root.
 * @returns True when the direct package name should be used.
 */
function isDirectChangesetPackage(packageDir: string): boolean {
  if (packageDir === 'core/contracts' || packageDir === 'packages/framework') {
    return true;
  }
  if (packageDir === 'sdks/typescript') {
    return true;
  }

  return (
    /^adapters\/implementations\/[^/]+$/u.test(packageDir) ||
    /^clients\/[^/]+$/u.test(packageDir) ||
    /^providers\/[^/]+$/u.test(packageDir) ||
    /^extensions\/[^/]+$/u.test(packageDir)
  );
}

/**
 * Finds the nearest direct changeset package for a path.
 * @param frameworkRoot - Absolute framework root.
 * @param file - Framework-root-relative file or directory path.
 * @returns Real package name, or `undefined` when the path belongs to framework infrastructure.
 */
function findDirectPackageName(frameworkRoot: string, file: string): string | undefined {
  const root = resolve(frameworkRoot);
  let current = resolveLookupDirectory(root, file);

  while (current !== root && current.startsWith(root)) {
    const manifestPath = resolve(current, 'package.json');
    if (existsSync(manifestPath)) {
      const packageDir = relative(root, current);
      if (!isDirectChangesetPackage(packageDir)) {
        return undefined;
      }
      return readPackageName(manifestPath);
    }
    current = dirname(current);
  }

  return undefined;
}

/**
 * Tests whether the path is a CodeRabbit display placeholder, not a real path.
 * @param file - Framework-root-relative path.
 * @returns True when the path contains an ellipsis segment.
 */
function isDisplayPlaceholder(file: string): boolean {
  return file.split('/').includes('...');
}

/**
 * Attempts to derive a publishable package name from a single file path.
 * @param file - File path relative to the framework repository root.
 * @param frameworkRoot - Absolute framework root.
 * @returns The package name, or `undefined` if the file is non-publishable.
 */
function resolvePackageName(file: string, frameworkRoot: string): string | undefined {
  if (isDisplayPlaceholder(file)) {
    return undefined;
  }

  for (const prefix of NON_PUBLISHABLE_PREFIXES) {
    if (file.startsWith(prefix)) {
      return undefined;
    }
  }

  return findDirectPackageName(frameworkRoot, file) ?? FRAMEWORK_PACKAGE;
}

/**
 * Maps changed file paths to the publishable npm packages they belong to.
 * @param files - File paths relative to the framework repository root.
 * @param options - Optional package lookup configuration.
 * @returns Deduplicated, sorted list of affected publishable package names.
 */
export function mapFilesToPackages(files: readonly string[], options: MapFilesToPackagesOptions = {}): string[] {
  const frameworkRoot = options.frameworkRoot ?? resolve(import.meta.dirname, '../../..');
  const packages = new Set<string>();

  for (const file of files) {
    const name = resolvePackageName(file, frameworkRoot);
    if (name !== undefined) {
      packages.add(name);
    }
  }

  return [...packages].sort();
}
