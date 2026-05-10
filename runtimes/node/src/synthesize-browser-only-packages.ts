import * as path from 'node:path';
import type { MakaioExtension } from '@makaio/contracts';
import type { DiscoveredExtension } from './extension-discovery.js';
import { defaultCreateMount, type BridgeBrowserOptions } from './create-static-mount.js';
import {
  buildExtensionBrowserRuntimeEntrypoint,
  buildExtensionBrowserUrlPrefix,
} from './extension-browser-entry-paths.js';
import { entrypointStem, resolveConventionEntrypoint } from './load-extensions.js';

/**
 * Result returned by {@link synthesizeBrowserOnlyPackages}.
 */
export interface SynthesizedBrowserOnlyResult {
  /** Synthesized {@link MakaioExtension} entries for browser-only extensions. */
  readonly packages: MakaioExtension[];
  /**
   * Config defaults from descriptors, keyed by extension name.
   *
   * Populated from `descriptor.config.defaults` for each synthesized extension.
   * Passed to `coordinator.load()` alongside the extension config defaults so
   * the coordinator can merge them with stored config at startup.
   */
  readonly configDefaults: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * Synthesize MakaioExtension objects for browser-only extensions.
 *
 * Extensions that declare `entrypoints.browser` but not `entrypoints.server`
 * cannot be loaded by `loadExtensions` (which requires a server entry).
 * This function creates minimal manifest-only packages from descriptor fields,
 * using the same URL convention and mount pattern as
 * {@link bridgeExtensionBrowserEntries}.
 *
 * The URL convention is `/extensions/<name>/browser/<entry-stem>.js`.
 * Static files are served from the directory containing the browser bundle.
 * @param discovered - All discovered extensions.
 * @param options - Optional overrides for testability (e.g. injected `createMount`).
 * @returns Synthesized packages and their config defaults.
 */
export function synthesizeBrowserOnlyPackages(
  discovered: ReadonlyArray<DiscoveredExtension>,
  options: BridgeBrowserOptions = {},
): SynthesizedBrowserOnlyResult {
  const { createMount = defaultCreateMount } = options;
  const packages: MakaioExtension[] = [];
  const configDefaults = new Map<string, Readonly<Record<string, unknown>>>();

  for (const ext of discovered) {
    const { descriptor, extensionPath } = ext;

    // Detached extensions run as child processes and have no entrypoints.
    if (descriptor.execution === 'detached') continue;
    // Skip extensions that have a server entry — those are handled by
    // loadExtensions + bridgeExtensionBrowserEntries.
    if (descriptor.entrypoints.server) continue;
    // Skip extensions that have no browser entry either.
    if (!descriptor.entrypoints.browser) continue;

    const browserEntrypointValue = descriptor.entrypoints.browser;
    const browserStem = entrypointStem('browser', browserEntrypointValue);

    const resolvedBrowserPath = resolveConventionEntrypoint('browser', browserEntrypointValue, extensionPath);
    if (!resolvedBrowserPath) {
      console.warn(
        `[extensions] ${descriptor.name}: browser entry has no resolvable candidate within extension directory, skipping synthesis`,
      );
      continue;
    }
    const serveRoot = path.dirname(resolvedBrowserPath);
    const urlPrefix = buildExtensionBrowserUrlPrefix(descriptor.name);
    const entrypoint = buildExtensionBrowserRuntimeEntrypoint(descriptor.name, browserStem);

    packages.push({
      name: descriptor.name,
      displayName: descriptor.displayName,
      ...(descriptor.surface !== undefined ? { surface: descriptor.surface } : {}),
      ...(descriptor.dependencies !== undefined ? { dependencies: descriptor.dependencies } : {}),
      browser: { entrypoint },
      http: {
        prefix: urlPrefix,
        mount: createMount(serveRoot, urlPrefix),
      },
    });

    if (descriptor.config?.defaults) {
      configDefaults.set(descriptor.name, descriptor.config.defaults);
    }
  }

  return { packages, configDefaults };
}
