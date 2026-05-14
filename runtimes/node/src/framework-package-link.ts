import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Options for linking the host-provided framework package into Makaio home. */
export interface EnsureFrameworkPackageLinkOptions {
  /** Runtime data home whose node_modules tree is used for installed extensions. */
  readonly makaioHome: string;
  /** Absolute path to the host-provided `@makaio/framework` package root. */
  readonly frameworkPackagePath: string;
}

/**
 * Link the host framework package into the managed extension resolution path.
 *
 * Packaged hosts own `@makaio/framework` as part of the app bundle. Installed
 * extensions resolve bare `@makaio/framework/*` imports through parent
 * `node_modules` lookup, so the managed `.makaio/node_modules` tree must point
 * at that host package instead of a registry-installed copy.
 * @param options - Link target and Makaio home.
 */
export async function ensureFrameworkPackageLink(options: EnsureFrameworkPackageLinkOptions): Promise<void> {
  const frameworkPackagePath = path.resolve(options.frameworkPackagePath);
  await assertFrameworkPackageRoot(frameworkPackagePath);

  const scopePath = path.join(options.makaioHome, 'node_modules', '@makaio');
  const linkPath = path.join(scopePath, 'framework');
  await fs.mkdir(scopePath, { recursive: true });

  if (await isLinkToTarget(linkPath, frameworkPackagePath)) {
    return;
  }

  // `.makaio/node_modules/@makaio/framework` is managed runtime dependency
  // state. Replacing it preserves the singleton invariant for future imports.
  await fs.rm(linkPath, { recursive: true, force: true });
  await fs.symlink(frameworkPackagePath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Verify that the supplied path is a framework package root.
 * @param frameworkPackagePath - Candidate package root.
 */
async function assertFrameworkPackageRoot(frameworkPackagePath: string): Promise<void> {
  const packageJsonPath = path.join(frameworkPackagePath, 'package.json');
  const raw = await fs.readFile(packageJsonPath, 'utf-8');
  const parsed = JSON.parse(raw) as { name?: unknown };
  if (parsed.name !== '@makaio/framework') {
    throw new Error(`Expected @makaio/framework package at ${frameworkPackagePath}`);
  }
}

/**
 * Check whether a path already points at a target.
 * @param linkPath - Managed framework package path.
 * @param targetPath - Desired host framework package path.
 * @returns Whether `linkPath` is already a symlink to `targetPath`.
 */
async function isLinkToTarget(linkPath: string, targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    return (await fs.realpath(linkPath)) === (await fs.realpath(targetPath));
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/**
 * Check whether a filesystem error is an expected missing-path condition.
 * @param error - Filesystem error.
 * @returns Whether the error means the checked path is absent.
 */
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
