import path from 'node:path';

/**
 * Build the stable browser URL prefix for an extension.
 * @param extensionName - Descriptor/package name of the extension.
 * @returns Public URL prefix for extension browser assets.
 */
export function buildExtensionBrowserUrlPrefix(extensionName: string): string {
  return `/extensions/${extensionName}/browser`;
}

/**
 * Build the Rollup input name for a descriptor browser entry.
 *
 * Vite appends `.js` through the `[name].js` output pattern, so the input name
 * intentionally omits the descriptor source extension.
 * @param extensionName - Descriptor/package name of the extension.
 * @param browserEntrypoint - Descriptor browser entrypoint path.
 * @returns Stable Rollup input name for the browser bundle.
 */
export function buildExtensionBrowserRollupInputName(extensionName: string, browserEntrypoint: string): string {
  return `extensions/${extensionName}/browser/${getEntrypointStem(browserEntrypoint)}`;
}

/**
 * Build the runtime import URL for a descriptor browser entry.
 *
 * Runtime URLs point at the JavaScript asset emitted by Vite, even when the
 * descriptor points at a TypeScript source entry.
 * @param extensionName - Descriptor/package name of the extension.
 * @param browserEntrypoint - Descriptor browser entrypoint path.
 * @returns Public browser entrypoint URL.
 */
export function buildExtensionBrowserRuntimeEntrypoint(extensionName: string, browserEntrypoint: string): string {
  return `/${buildExtensionBrowserRollupInputName(extensionName, browserEntrypoint)}.js`;
}

/**
 * Return the final path segment without its source extension.
 * @param browserEntrypoint - Descriptor browser entrypoint path.
 * @returns Extension-free browser entrypoint basename.
 */
function getEntrypointStem(browserEntrypoint: string): string {
  const normalizedEntrypoint = browserEntrypoint.replaceAll(path.win32.sep, path.posix.sep);
  const filename = path.posix.basename(normalizedEntrypoint);
  const extension = path.posix.extname(filename);
  return extension ? filename.slice(0, -extension.length) : filename;
}
