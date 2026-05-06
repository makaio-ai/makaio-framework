/**
 * Canonical shared browser dependencies that extension bundles may
 * externalize and that the host shell resolves via import map injection.
 *
 * Order is intentional and stable so downstream consumers can produce
 * deterministic import-map JSON and warning sequences.
 */
export const SHARED_BROWSER_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@makaio/ui-kernel',
  '@makaio/ui-hooks',
  '@makaio/ui-components',
  '@makaio/ui-views',
] as const;

/**
 * Union of all supported shared browser dependency specifiers.
 */
export type SharedBrowserExternal = (typeof SHARED_BROWSER_EXTERNALS)[number];

const SHARED_BROWSER_EXTERNAL_SET = new Set<string>(SHARED_BROWSER_EXTERNALS);

/**
 * Check whether a specifier is part of the framework-owned shared browser
 * dependency contract.
 * @param specifier - Bare module specifier to check.
 * @returns True when the specifier is supported as a shared browser external.
 */
export function isSharedBrowserExternal(specifier: string): specifier is SharedBrowserExternal {
  return SHARED_BROWSER_EXTERNAL_SET.has(specifier);
}

/**
 * Convert a shared browser external specifier into the stable synthetic
 * Rollup input name used by the host import-map build.
 * @param specifier - Shared browser external specifier.
 * @returns Stable Rollup input key for the generated facade entry chunk.
 */
export function toSharedBrowserExternalEntryName(specifier: SharedBrowserExternal): string {
  return `__makaio_shared_${specifier.replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '_')}`;
}
