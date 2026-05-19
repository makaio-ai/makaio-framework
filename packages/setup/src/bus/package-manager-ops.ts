/**
 * Bus operation wrappers for extension package installation.
 *
 * Encapsulates package manager RPC calls used by the setup flow,
 * keeping bus subject access isolated from higher-level controllers.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { PackageSubjects } from '@makaio/services-package-manager';
import type { InstallProgress } from '../types.js';

/**
 * Installs extension packages sequentially via the package manager bus subject.
 *
 * Each package is installed individually so that a failure in one package
 * surfaces a clear error identifying the offending package. On the first
 * failure the function throws immediately without attempting the remaining
 * packages.
 * @param bus - The bus instance.
 * @param packageNames - Package names to install (in order).
 * @returns Install progress entries for each package, up to and including
 *   any failing package.
 * @throws If any package installation fails.
 */
export async function installExtensionPackages(
  bus: IMakaioBus,
  packageNames: readonly string[],
): Promise<InstallProgress[]> {
  const results: InstallProgress[] = [];

  for (const packageName of packageNames) {
    const response = await bus.request(PackageSubjects.install, {
      packageNames: [packageName],
      source: 'npm' as const,
    });

    const progress: InstallProgress = {
      packageName,
      success: response.success,
      restartRequired: response.restartRequired,
      error: response.error ?? undefined,
    };

    results.push(progress);

    if (!response.success) {
      throw new Error(`Failed to install ${packageName}: ${response.error ?? 'unknown error'}`);
    }
  }

  return results;
}
