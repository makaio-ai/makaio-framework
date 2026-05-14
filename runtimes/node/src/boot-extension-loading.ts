import type { KernelMakaioExtension } from '@makaio/kernel';
import {
  attachExtensionCliContributions,
  isDescriptorFrameworkCompatible,
  loadExtensions,
  type ExtensionCliAttachResult,
  type ExtensionLoadResult,
} from './load-extensions.js';
import { bridgeExtensionBrowserEntries } from './bridge-extension-browser-entries.js';
import {
  synthesizeBrowserOnlyPackages,
  type SynthesizedBrowserOnlyResult,
} from './synthesize-browser-only-packages.js';
import type { DiscoveredExtension } from './extension-discovery.js';
import { readFrameworkVersion } from './read-framework-version.js';
import type { ResolvedExtensionOptions } from './resolve-extension-options.js';

/**
 * Result of descriptor discovery, executable loading, browser bridging, and
 * CLI contribution attachment during boot.
 */
export interface BootExtensionLoadingResult {
  /** Descriptors discovered after applying skip filters. */
  readonly discovered: ReadonlyArray<DiscoveredExtension>;
  /** Server-entry extension loading result. */
  readonly extensionLoadResult: ExtensionLoadResult;
  /** Browser-only synthesized package result. */
  readonly browserOnlyResult: SynthesizedBrowserOnlyResult;
  /** Packages augmented or synthesized with CLI contributions. */
  readonly extensionsWithCli: ExtensionCliAttachResult;
  /** Final extension package list before capability and enablement gating. */
  readonly allExtensionPackages: ReadonlyArray<KernelMakaioExtension>;
}

/**
 * Discover extension descriptors and assemble executable package surfaces for
 * coordinator loading.
 * @param options - Discovery, framework-version, and skip-filter inputs.
 * @returns Descriptor discovery and package-loading results for boot.
 */
export async function loadBootExtensions(options: {
  readonly extensionOptions: ResolvedExtensionOptions;
  readonly skipExtensions: ReadonlySet<string>;
  readonly frameworkVersion: string | undefined;
}): Promise<BootExtensionLoadingResult> {
  let extensionLoadResult: ExtensionLoadResult = {
    packages: [],
    configDefaults: new Map(),
  };
  let discovered: ReadonlyArray<DiscoveredExtension> = [];
  const frameworkVersion = options.frameworkVersion ?? (await readFrameworkVersion());

  try {
    discovered = await options.extensionOptions.extensions.discover();
    discovered = filterSkippedExtensions(discovered, options.skipExtensions);

    if (process.env['MAKAIO_DEBUG']) {
      console.info('[boot] Discovered %d extension descriptor(s):', discovered.length);
      for (const ext of discovered) {
        console.info('[boot]   - %s (%s)', ext.descriptor.displayName ?? ext.descriptor.name, ext.source);
      }
    }
  } catch (err) {
    console.warn('[boot] Extension discovery failed, skipping:', err instanceof Error ? err.message : err);
  }

  const compatible = discovered.filter((ext) => isDescriptorFrameworkCompatible(ext, frameworkVersion));

  if (compatible.length > 0) {
    try {
      extensionLoadResult = await loadExtensions(compatible, {
        frameworkVersion,
      });
    } catch (err) {
      console.warn('[boot] Extension loading failed, skipping:', err instanceof Error ? err.message : err);
    }
  }

  const bridgedPackages = bridgeExtensionBrowserEntries(compatible, extensionLoadResult.packages);
  const browserOnlyResult = synthesizeBrowserOnlyPackages(compatible, { frameworkVersion });
  const extensionsWithCli = await attachExtensionCliContributions(
    compatible,
    [...bridgedPackages, ...browserOnlyResult.packages],
    { frameworkVersion },
  );

  return {
    discovered,
    extensionLoadResult,
    browserOnlyResult,
    extensionsWithCli,
    allExtensionPackages: extensionsWithCli.packages,
  };
}

/**
 * Apply the `MAKAIO_SKIP_EXTENSIONS` filter to discovered descriptors.
 * @param discovered - Descriptors returned by the configured discovery strategy.
 * @param skipExtensions - Extension names requested by the environment filter.
 * @returns Descriptors remaining after the skip filter.
 */
function filterSkippedExtensions(
  discovered: ReadonlyArray<DiscoveredExtension>,
  skipExtensions: ReadonlySet<string>,
): ReadonlyArray<DiscoveredExtension> {
  if (skipExtensions.size === 0) return discovered;

  const discoveredNames = new Set(discovered.map((e) => e.descriptor.name));
  const unmatched = [...skipExtensions].filter((n) => !discoveredNames.has(n));
  if (unmatched.length) {
    console.warn('[boot] MAKAIO_SKIP_EXTENSIONS: no matching extension(s): %s', unmatched.join(', '));
  }

  const skipSet = new Set([...skipExtensions].filter((n) => discoveredNames.has(n)));
  const filtered = discovered.filter((e) => !skipSet.has(e.descriptor.name));
  if (filtered.length < discovered.length) {
    console.info(
      '[boot] MAKAIO_SKIP_EXTENSIONS filtered %d extension(s): %s',
      discovered.length - filtered.length,
      [...skipSet].join(', '),
    );
  }

  return filtered;
}
