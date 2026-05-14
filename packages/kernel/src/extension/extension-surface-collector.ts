import type { TrayManifest } from '@makaio/contracts';
import type { CliContribution } from '../cli/types.js';
import type { WindowRegistry } from '../window/window-registry.js';
import type { ExtensionEntry, KernelMakaioExtension } from './types.js';

/** Mutable extension surfaces collected during coordinator load. */
export interface ExtensionSurfaceCollections {
  /** Registry populated with extension-declared windows. */
  readonly windowRegistry: WindowRegistry;
  /** Tray entries collected in load order. */
  readonly trayEntries: Array<TrayManifest & { readonly packageName: string }>;
  /** CLI contributions collected in load order. */
  readonly cliContributions: CliContribution[];
}

/**
 * Collect static window, tray, and CLI surfaces declared by one extension.
 * @param collections - Surface registries owned by the coordinator.
 * @param pkg - Extension manifest whose static surfaces should be collected.
 */
export function collectExtensionSurfaces(collections: ExtensionSurfaceCollections, pkg: KernelMakaioExtension): void {
  if (pkg.windows) {
    for (const window of pkg.windows) {
      collections.windowRegistry.register(pkg.name, pkg.displayName, window);
    }
  }
  if (pkg.tray) {
    collections.trayEntries.push({ ...pkg.tray, packageName: pkg.name });
  }
  if (pkg.cli) {
    const cli = pkg.cli as CliContribution;
    if ('subcommands' in cli) {
      collections.cliContributions.push(cli);
    }
  }
}

/**
 * Return enabled loaded extensions that declare HTTP routes.
 * @param entries - Loaded coordinator entries keyed by extension name.
 * @returns Extensions with HTTP route manifests.
 */
export function extensionsWithHttp(
  entries: ReadonlyMap<string, ExtensionEntry>,
): ReadonlyArray<KernelMakaioExtension & { readonly http: NonNullable<KernelMakaioExtension['http']> }> {
  return Array.from(entries.values())
    .filter((entry) => entry.enabled)
    .map((entry) => entry.pkg)
    .filter(
      (pkg): pkg is KernelMakaioExtension & { readonly http: NonNullable<KernelMakaioExtension['http']> } => !!pkg.http,
    );
}
