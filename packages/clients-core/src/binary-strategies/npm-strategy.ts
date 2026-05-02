/**
 * npm install strategy.
 *
 * Resolves the latest published version of an npm package via `npm view` and
 * installs a pinned version into a sandbox directory using `npm install --prefix`.
 * No global state is modified.
 * @packageDocumentation
 */

import type { NpmInstallDescriptor } from '@makaio/contracts/client';
import type { InstallArtifact, InstallStrategy, StrategyDependencies, StrategyProgressCallback } from './types.js';

/**
 * Concrete install strategy for the `npm` descriptor type.
 *
 * The strategy sandboxes the install under `targetDir` so the framework
 * controls the installation root rather than the user's global npm prefix.
 * The `--no-save` flag prevents writing a `package.json` or lock file
 * into the target directory, keeping the install directory minimal.
 */
export class NpmStrategy implements InstallStrategy {
  readonly #descriptor: NpmInstallDescriptor;
  readonly #deps: StrategyDependencies;

  /**
   * @param descriptor - The npm install descriptor.
   * @param deps - Injected I/O dependencies.
   */
  public constructor(descriptor: NpmInstallDescriptor, deps: StrategyDependencies) {
    this.#descriptor = descriptor;
    this.#deps = deps;
  }

  /**
   * Resolve the latest published version of the package from the npm registry.
   *
   * Runs `npm view {package} version --json` and strips the surrounding quotes
   * that npm adds when `--json` is used.
   * @returns The latest version string from the npm registry.
   */
  public async resolveLatestVersion(): Promise<string> {
    const raw = await this.#deps.exec('npm', ['view', this.#descriptor.package, 'version', '--json']);
    // `npm view … --json` wraps the version string in double quotes.
    return raw.trim().replace(/^"|"$/g, '');
  }

  /**
   * Execute the npm sandbox install.
   *
   * Runs `npm install {package}@{version} --prefix {targetDir} --no-save`.
   * @param version - The exact version to install.
   * @param targetDir - Absolute path to the prefix directory for the install.
   * @param onProgress - Optional progress callback invoked at each pipeline stage.
   * @returns A normalized install artifact pointing to `targetDir`.
   */
  public async execute(
    version: string,
    targetDir: string,
    onProgress?: StrategyProgressCallback,
  ): Promise<InstallArtifact> {
    onProgress?.('installing', null);

    const packageSpec = `${this.#descriptor.package}@${version}`;
    await this.#deps.exec('npm', ['install', packageSpec, '--prefix', targetDir, '--no-save', '--ignore-scripts']);

    onProgress?.('installing', 100);

    return {
      installPath: targetDir,
      version,
      strategy: 'npm',
    };
  }
}
