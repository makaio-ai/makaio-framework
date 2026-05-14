import * as path from 'node:path';
import type { KernelMakaioExtension } from '@makaio/kernel';
import type { DiscoveredExtension } from './extension-discovery.js';
import { defaultCreateMount, type BridgeBrowserOptions } from './create-static-mount.js';
import {
  buildExtensionBrowserRuntimeEntrypoint,
  buildExtensionBrowserUrlPrefix,
} from './extension-browser-entry-paths.js';
import { entrypointStem, resolveConventionEntrypoint } from './load-extensions.js';

export type { BridgeBrowserOptions };

/**
 * Augment extension packages with browser entry and HTTP serving fields.
 *
 * For each loaded package whose descriptor declares `entrypoints.browser`,
 * adds `browser` (URL entrypoint) and `http` (static file serving) fields.
 * Skips packages that already declare either field — the server entry author
 * is assumed to handle their own serving.
 *
 * The URL convention is `/extensions/<name>/browser/<entry-stem>.js`.
 * Static files are served from the directory containing the browser bundle.
 * @param discovered - The discovered extensions (for descriptor access).
 * @param packages - Loaded {@link KernelMakaioExtension} array from `loadExtensions`.
 * @param options - Optional injection overrides for testability.
 * @returns New array with augmented packages. Input array is not mutated.
 */
export function bridgeExtensionBrowserEntries(
  discovered: ReadonlyArray<DiscoveredExtension>,
  packages: ReadonlyArray<KernelMakaioExtension>,
  options: BridgeBrowserOptions = {},
): KernelMakaioExtension[] {
  const { createMount = defaultCreateMount } = options;
  const descriptorByName = new Map(discovered.map((d) => [d.descriptor.name, d]));

  return packages.map((pkg) => {
    const ext = descriptorByName.get(pkg.name);
    if (!ext?.descriptor.entrypoints?.browser) return pkg;

    if (pkg.browser) {
      console.warn(`[extensions] ${pkg.name}: server entry already declares browser, skipping browser bridge`);
      return pkg;
    }

    if (pkg.http) {
      console.warn(`[extensions] ${pkg.name}: server entry already declares http, skipping browser bridge`);
      return pkg;
    }

    const browserEntrypointValue = ext.descriptor.entrypoints.browser;
    const browserStem = entrypointStem('browser', browserEntrypointValue);

    const resolvedBrowserPath = resolveConventionEntrypoint('browser', browserEntrypointValue, ext.extensionPath);
    if (!resolvedBrowserPath) {
      console.warn(
        `[extensions] ${pkg.name}: browser entry has no resolvable candidate within extension directory, skipping bridge`,
      );
      return pkg;
    }
    const serveRoot = path.dirname(resolvedBrowserPath);
    const urlPrefix = buildExtensionBrowserUrlPrefix(pkg.name);
    const entrypoint = buildExtensionBrowserRuntimeEntrypoint(pkg.name, browserStem);

    return {
      ...pkg,
      browser: { entrypoint },
      http: {
        prefix: urlPrefix,
        mount: createMount(serveRoot, urlPrefix),
      },
    };
  });
}
