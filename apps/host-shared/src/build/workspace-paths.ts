import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the workspace root from a host package directory.
 *
 * Kept local to build helpers so Electrobun config loading can use this module
 * without resolving workspace package exports first.
 * @param packageDir - Absolute path to a host package directory.
 * @returns Absolute workspace root.
 */
export function resolveWorkspaceRoot(packageDir: string): string {
  if (!path.isAbsolute(packageDir)) {
    throw new Error(`[host-build] packageDir must be absolute. Received: "${packageDir}"`);
  }

  const candidates = [
    path.resolve(packageDir, '../..'),
    path.resolve(packageDir, '../../..'),
    path.resolve(packageDir, '../../../..'),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'package.json'))) {
      const parentDir = path.dirname(candidate);
      if (
        path.basename(candidate) === 'framework' &&
        existsSync(path.join(parentDir, 'package.json')) &&
        existsSync(path.join(parentDir, 'framework', 'package.json'))
      ) {
        return parentDir;
      }
      return candidate;
    }
  }

  throw new Error(
    `[host-build] Could not resolve workspace root from "${packageDir}". Checked:\n${candidates
      .map((candidate) => `- ${candidate}`)
      .join('\n')}`,
  );
}

/**
 * Resolve the source directory that contains this package set.
 * @param workspaceRoot - Resolved workspace root.
 * @returns Directory containing apps/packages/runtimes folders.
 */
export function resolvePackageSetRoot(workspaceRoot: string): string {
  const nestedPackageSetRoot = path.join(workspaceRoot, 'framework');
  if (existsSync(path.join(nestedPackageSetRoot, 'package.json'))) {
    return nestedPackageSetRoot;
  }

  return workspaceRoot;
}

/**
 * Resolve the storage-migrations drizzle directory across both supported source layouts.
 *
 * The framework may live at the repository root or under a source-tree prefix
 * during local development. This helper accepts either layout and returns the
 * first existing migrations directory.
 * @param packageRoot - Absolute path to the host package root.
 * @returns Absolute path to the storage-migrations drizzle folder.
 * @throws If neither supported source layout contains the migrations directory.
 */
export function resolveStorageMigrationsDir(packageRoot: string): string {
  const workspaceRoot = resolveWorkspaceRoot(packageRoot);
  const candidates = [
    path.join(workspaceRoot, 'storage', 'migrations', 'drizzle'),
    path.join(workspaceRoot, 'framework', 'storage', 'migrations', 'drizzle'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `[host-build] Could not resolve storage migrations directory. Checked:\n${candidates
      .map((candidate) => `- ${candidate}`)
      .join('\n')}`,
  );
}

/**
 * Resolve the runtime-node package metadata path across supported source layouts.
 * @param workspaceRoot - Resolved repository root.
 * @returns Absolute path to `@makaio/runtime-node/package.json`.
 * @throws If neither supported source layout contains the package metadata.
 */
export function resolveRuntimeNodePackageJsonPath(workspaceRoot: string): string {
  const packageSetRoot = resolvePackageSetRoot(workspaceRoot);
  const candidates = [path.join(packageSetRoot, 'runtimes', 'node', 'package.json')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `[host-build] Could not resolve @makaio/runtime-node package metadata. Checked:\n${candidates
      .map((candidate) => `- ${candidate}`)
      .join('\n')}`,
  );
}

/**
 * Read and validate a package version from package metadata.
 * @param packageJsonPath - Absolute path to a package.json file.
 * @returns Package version string.
 * @throws If the package metadata cannot be parsed or lacks a non-empty string version.
 */
export function readPackageVersion(packageJsonPath: string): string {
  let parsedPackageJson: unknown;

  try {
    parsedPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read package version from ${packageJsonPath}: ${reason}`, { cause: error });
  }

  if (
    typeof parsedPackageJson !== 'object' ||
    parsedPackageJson === null ||
    !('version' in parsedPackageJson) ||
    typeof parsedPackageJson.version !== 'string' ||
    parsedPackageJson.version.trim().length === 0
  ) {
    throw new Error(`Invalid package metadata at ${packageJsonPath}: expected a non-empty string "version".`);
  }

  return parsedPackageJson.version;
}
