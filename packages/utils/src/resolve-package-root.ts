import { fileURLToPath } from 'node:url';

/**
 * Resolve a server-side package root from an ESM import meta object.
 *
 * Browser imports intentionally return `undefined` so package declarations can
 * be evaluated by UI bundles without resolving filesystem paths.
 * @param importMeta - Module import metadata from the package entrypoint.
 * @returns Parent directory of the package entrypoint, or `undefined` in browser/non-file contexts.
 */
export function resolvePackageRoot(importMeta: Pick<ImportMeta, 'url'>): string | undefined {
  const runtimeGlobal = globalThis as typeof globalThis & { window?: unknown };
  return runtimeGlobal.window === undefined && importMeta.url.startsWith('file:')
    ? fileURLToPath(new URL('..', importMeta.url))
    : undefined;
}
