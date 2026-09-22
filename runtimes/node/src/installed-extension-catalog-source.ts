/**
 * The runtime's own installed-extension catalog, as handed to the extension
 * coordinator.
 *
 * Answers "what is installed on the machine running this process", which is
 * what lets `kernel:extension.setEnabled` validate a preference for a name
 * this process never loaded, and what lets a client that cannot see this
 * machine's filesystem enumerate it at all.
 * @packageDocumentation
 */
import type { InstalledExtensionCatalogSource } from '@makaio/kernel';
import type { ExtensionDiscovery } from './extension-discovery.js';
import { createWorkerExportedPackagesReader } from './installed-extension-readers.js';
import { scanInstalledExtensions } from './installed-extension-scan.js';

/** Inputs for {@link createInstalledExtensionCatalogSource}. */
export interface InstalledExtensionCatalogSourceOptions {
  /**
   * The discovery strategy this host boots with.
   *
   * The catalog must describe the same view the next boot would see — its
   * configured roots, its tier precedence and its descriptor filters — or it
   * would refuse a name the runtime can load and offer names the runtime would
   * never discover. Passing the resolved strategy itself, rather than a
   * reconstruction of its inputs, is what makes that equality structural.
   */
  readonly discovery: ExtensionDiscovery;
  /**
   * Absolute path to the assembled `@makaio/framework` dist when this host
   * resolves `@makaio/framework/*` through a module resolver hook; omitted for
   * hosts that resolve those specifiers natively.
   */
  readonly frameworkDistPath?: string;
}

/**
 * Build the catalog source for a long-lived runtime.
 *
 * Always reads through the isolated import worker: this process can be asked
 * again after an extension is reinstalled in place, and an import on its own
 * module registry would keep answering from the pre-update module. Each call
 * re-scans rather than caching, for the same reason — the point of the catalog
 * is to describe what the *next* boot would load, which changes underneath a
 * running process every time an extension is installed or removed.
 * @param options - Discovery view and framework resolution for this host.
 * @returns A catalog source suitable for `ExtensionCoordinatorOptions.installedCatalog`.
 */
export function createInstalledExtensionCatalogSource(
  options: InstalledExtensionCatalogSourceOptions,
): InstalledExtensionCatalogSource {
  const exportedPackages = createWorkerExportedPackagesReader(options.frameworkDistPath);
  return () => scanInstalledExtensions({ discovery: options.discovery, exportedPackages });
}
