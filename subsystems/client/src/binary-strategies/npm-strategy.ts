/**
 * npm install strategy.
 *
 * Installs a pinned version of an npm package into a sandbox directory using
 * `npm install --prefix`. No global state is modified. The version is always
 * taken from the descriptor — callers cannot override it at install time.
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
 *
 * Managed npm installs are pin-only: the descriptor must carry an exact
 * `version` field and `execute` rejects any caller-supplied version that
 * differs from that pin. This guarantees reproducible installs across
 * machines and time.
 */
export class NpmStrategy implements InstallStrategy {
  readonly #descriptor: NpmInstallDescriptor;
  readonly #deps: StrategyDependencies;

  /**
   * @param descriptor - The npm install descriptor (must include an exact `version` pin).
   * @param deps - Injected I/O dependencies.
   */
  public constructor(descriptor: NpmInstallDescriptor, deps: StrategyDependencies) {
    this.#descriptor = descriptor;
    this.#deps = deps;
  }

  /**
   * Execute the npm sandbox install.
   *
   * Validates that `version` matches the descriptor pin, then runs
   * `npm install <package>@<version> --prefix <targetDir> --no-save --ignore-scripts`.
   * @param version - The exact version to install. Must match the descriptor pin.
   * @param targetDir - Absolute path to the prefix directory for the install.
   * @param onProgress - Optional progress callback invoked at each pipeline stage.
   * @returns A normalized install artifact pointing to `targetDir`.
   * @throws When `version` differs from the pinned version in the descriptor.
   */
  public async execute(
    version: string,
    targetDir: string,
    onProgress?: StrategyProgressCallback,
  ): Promise<InstallArtifact> {
    if (version !== this.#descriptor.version) {
      throw new Error(
        `npm managed install requested version ${version} but descriptor pins ${this.#descriptor.version}`,
      );
    }

    onProgress?.('installing', null);

    const packageSpec = `${this.#descriptor.package}@${this.#descriptor.version}`;
    await this.#deps.exec('npm', ['install', packageSpec, '--prefix', targetDir, '--no-save', '--ignore-scripts']);

    onProgress?.('installing', 100);

    return {
      installPath: targetDir,
      version: this.#descriptor.version,
      strategy: 'npm',
    };
  }
}
