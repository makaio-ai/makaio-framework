/**
 * Shared utilities for discovering publishable framework packages.
 *
 * Used by `build-public-packages.ts` and `validate-npm-packlists.ts` to
 * locate the set of packages that participate in the public npm release.
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal package.json shape needed by package discovery and build scripts. */
export interface PublicPackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly scripts?: {
    readonly build?: string;
  };
  readonly exports?: unknown;
  readonly main?: string;
  readonly types?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly publishConfig?: {
    readonly access?: string;
    readonly directory?: string;
    readonly exports?: unknown;
  };
}

const SKIPPED_DIRS = new Set(['.yarn', 'build', 'dist', 'lib', 'node_modules', '__tests__']);

/**
 * Read and parse package.json from a directory.
 * @param packageDir - Directory containing package.json.
 * @returns Parsed package metadata.
 */
export function readPackageJson(packageDir: string): PublicPackageJson {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PublicPackageJson;
}

/**
 * Recursively find framework package directories marked as public npm packages.
 * @param root - Directory to scan.
 * @returns Package directories with `publishConfig.access === "public"`.
 */
export function findPublicPackageDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;

    const dir = join(root, entry.name);
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = readPackageJson(dir);
      if (pkg.publishConfig?.access === 'public') {
        dirs.push(dir);
      }
    }
    dirs.push(...findPublicPackageDirs(dir));
  }
  return dirs;
}
