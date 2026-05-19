/**
 * Dev-mode workspace package discovery.
 *
 * Scans workspace packages from the root `package.json` globs and builds a
 * {@link DevPortalMap} for use by the package-manager service. Also resolves
 * the `@makaio/framework` package root so boot can link it for extension
 * resolution without fetching from npm.
 *
 * This module is a no-op in packaged / production builds: when no workspace
 * root is found, all exported helpers return `undefined`.
 * @packageDocumentation
 */

import { findWorkspaceRootInfo, WorkspaceRootNotFoundError } from '@makaio/runtime-node';
import type { DevPortalMap } from '@makaio/services-package-manager';
import { discoverWorkspacePackageIndex } from '@makaio/utils/workspace-packages';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of workspace package discovery.
 *
 * Both fields are derived from the same workspace scan so they are always
 * consistent with each other.
 */
export interface DevWorkspacePackages {
  /**
   * Map from npm package name to its absolute workspace source directory.
   *
   * Covers all packages found under the workspace globs. Passed to the
   * package-manager service so extension install specs for known workspace
   * packages are rewritten to Yarn `portal:` ranges.
   */
  readonly devPortalPackages: DevPortalMap;
  /**
   * Absolute path to the {@link FRAMEWORK_PACKAGE_NAME} workspace source directory.
   *
   * Used by boot to link the framework package for extension resolution.
   * `undefined` when the framework package is not found in the workspace.
   */
  readonly frameworkPackagePath: string | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Package name used to resolve `frameworkPackagePath` from workspace entries. */
const FRAMEWORK_PACKAGE_NAME = '@makaio/framework';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Scan workspace packages starting from the given workspace root.
 *
 * Uses the workspace globs from root `package.json` to discover all package
 * descriptors. Builds a {@link DevPortalMap} from `name` → directory path and
 * picks out the framework package as the `frameworkPackagePath`.
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param workspaces - Workspace globs already read during root discovery.
 * @returns Discovered workspace package data.
 */
async function scanWorkspacePackages(
  workspaceRoot: string,
  workspaces: readonly string[],
): Promise<DevWorkspacePackages> {
  const map = await discoverWorkspacePackageIndex(workspaceRoot, { patterns: workspaces });
  const frameworkPackagePath = map.get(FRAMEWORK_PACKAGE_NAME);

  return { devPortalPackages: new Map(map), frameworkPackagePath };
}

/**
 * Discover dev-mode workspace packages when running in a workspace environment.
 *
 * Calls {@link findWorkspaceRootInfo} from `process.cwd()`. When no workspace root
 * is found (packaged / production builds), returns `undefined` gracefully.
 *
 * This is the main entry point for CLI boot — call it once during startup and
 * pass the result into {@link ServeBootOverrides}.
 * @param cwd - Directory to start searching from. Defaults to `process.cwd()`.
 * @returns Workspace package data, or `undefined` when not in a workspace.
 */
export async function discoverDevWorkspacePackages(cwd = process.cwd()): Promise<DevWorkspacePackages | undefined> {
  let workspaceRoot: string;
  let workspaces: readonly string[];
  try {
    const workspace = findWorkspaceRootInfo(cwd);
    workspaceRoot = workspace.root;
    workspaces = workspace.workspaces;
  } catch (error) {
    if (error instanceof WorkspaceRootNotFoundError) {
      return undefined;
    }
    throw error;
  }

  return scanWorkspacePackages(workspaceRoot, workspaces);
}
