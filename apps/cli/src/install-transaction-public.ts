/**
 * Narrow public subpath for extension install transaction helpers.
 *
 * Exposes only the transaction-level functions and result types needed by
 * downstream package facades and external command surfaces. Command registration
 * functions are intentionally excluded — those are CLI-internal.
 * @packageDocumentation
 */

import { resolveMakaioHome } from '@makaio/runtime-node/makaio-config';
import { findProjectManifestPath, readProjectManifest } from '@makaio/utils/project-manifest';

import {
  installMissingManifestExtensions,
  type ExtensionInstallTransactionResult,
} from './extension-install-transaction.js';

export { installExtensionSources } from './extension-install-transaction.js';
export type {
  DirectNpmInstallResolution,
  ExtensionInstallTransactionResult,
} from './extension-install-transaction.js';

/**
 * Install missing or version-mismatched extensions declared in a project
 * manifest.
 *
 * When no `manifestPath` is provided the function walks upward from the
 * current working directory to locate a `.makaio/manifest.json` file,
 * stopping at the nearest git root. If no manifest is found, the function
 * throws an error.
 * @param manifestPath - Explicit path to the project manifest file. When
 *   omitted, the manifest is discovered by walking up from `process.cwd()`.
 * @returns Transaction result describing what changed, or `null` when all
 *   declared extensions are already satisfied.
 * @throws If no project manifest is found when `manifestPath` is omitted.
 */
export async function installProjectExtensions(
  manifestPath?: string,
): Promise<ExtensionInstallTransactionResult | null> {
  const explicitManifestPath = manifestPath?.trim();
  const resolvedPath = explicitManifestPath ? explicitManifestPath : await findProjectManifestPath(process.cwd());

  if (resolvedPath === null) {
    throw new Error('No .makaio/manifest.json found from the current directory.');
  }

  const manifest = await readProjectManifest(resolvedPath);
  const makaioHome = resolveMakaioHome();

  return installMissingManifestExtensions(manifest.extensions, makaioHome);
}
