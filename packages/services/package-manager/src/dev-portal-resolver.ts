/**
 * Dev Portal Resolver
 *
 * Wraps {@link DependencyPackageManager} for dev-mode installs, intercepting
 * `installPackage` calls and rewriting specs for known workspace packages to
 * Yarn `portal:` ranges pointing at local source directories. All other
 * methods are delegated to the inner package manager unchanged.
 *
 * This mirrors the `portal:` pattern used for `@makaio/framework` via
 * `frameworkPackagePath`, extending it to the full set of extension packages
 * available in the host workspace.
 * @packageDocumentation
 */

import type { ExtensionDescriptor } from '@makaio/contracts';
import type { DependencyPackageManager } from './dependency-resolver.js';
import type { InstalledExtensionDescriptor } from './yarn-integration.js';
import { extractNpmName, toYarnPortablePath } from './yarn-integration.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Map from npm package name to the absolute filesystem path of its workspace
 * source directory.
 *
 * Used by {@link DevPortalPackageManager} to rewrite install specs to Yarn
 * `portal:` ranges during dev mode runs.
 * @example
 * ```ts
 * new Map([
 *   ['@makaio/client-claude-code', '/workspace/extensions/client-claude-code'],
 * ])
 * ```
 */
export type DevPortalMap = ReadonlyMap<string, string>;

// ---------------------------------------------------------------------------
// DevPortalPackageManager
// ---------------------------------------------------------------------------

/**
 * Dev-mode wrapper around {@link DependencyPackageManager} that rewrites
 * install specs for known workspace packages to Yarn `portal:` ranges.
 *
 * During a normal dev-mode run the npm registry may not have the extension
 * packages published yet. Providing a {@link DevPortalMap} lets the resolver
 * skip the registry entirely and link directly to workspace source directories
 * via Yarn's `portal:` protocol, which is already used for `@makaio/framework`.
 *
 * Only `installPackage` is intercepted; all other methods are forwarded to the
 * inner package manager unchanged.
 */
export class DevPortalPackageManager implements DependencyPackageManager {
  /**
   * @param inner - The underlying package manager that performs real Yarn operations.
   * @param portalMap - Map of npm name → absolute workspace directory path.
   */
  public constructor(
    private readonly inner: DependencyPackageManager,
    private readonly portalMap: DevPortalMap,
  ) {}

  /**
   * Install a package, rewriting the specifier to a `portal:` range when the
   * npm name is present in the {@link DevPortalMap}.
   *
   * When the npm name matches, the range portion of `packageSpec` is discarded
   * and replaced with `portal:<portable-path>` so Yarn links to the local
   * workspace directory. Unmatched specs are forwarded as-is.
   * @param packageSpec - Yarn-compatible specifier (e.g. `@acme/pkg` or `@acme/pkg@>=1.0.0`).
   * @returns Resolved version string from the inner package manager.
   */
  public async installPackage(packageSpec: string): Promise<string> {
    const npmName = extractNpmName(packageSpec);
    const workspacePath = this.portalMap.get(npmName);

    if (workspacePath !== undefined) {
      const portalSpec = `${npmName}@portal:${toYarnPortablePath(workspacePath)}`;
      return this.inner.installPackage(portalSpec);
    }

    return this.inner.installPackage(packageSpec);
  }

  /**
   * Read and validate the `descriptor.json` for an installed package.
   * @param npmName - npm package name (e.g. `@acme/weather-tools`).
   * @returns Validated descriptor or `null` when absent or invalid.
   */
  public readInstalledExtensionDescriptor(npmName: string): Promise<ExtensionDescriptor | null> {
    return this.inner.readInstalledExtensionDescriptor(npmName);
  }

  /**
   * List all packages in `node_modules` that ship a valid descriptor.
   * @returns Array of installed extension descriptor records.
   */
  public listInstalledExtensionDescriptors(): Promise<InstalledExtensionDescriptor[]> {
    return this.inner.listInstalledExtensionDescriptors();
  }

  /**
   * Snapshot the current `package.json` for later restoration.
   * @returns Opaque snapshot token.
   */
  public readManifestSnapshot(): Promise<unknown> {
    return this.inner.readManifestSnapshot();
  }

  /**
   * Write a snapshot back to `package.json` and run `yarn install` to reconcile.
   * @param snapshot - Opaque snapshot obtained from {@link readManifestSnapshot}.
   * @returns Promise that resolves when reinstall completes.
   */
  public writeManifestAndReinstall(snapshot: unknown): Promise<void> {
    return this.inner.writeManifestAndReinstall(snapshot);
  }
}
