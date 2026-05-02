/**
 * Window preload script — injects runtime configuration into the renderer.
 *
 * Reads the window registration ID, package name, and bus URL from Electron's
 * additionalArguments (passed via WindowManager) and exposes them as
 * window.__MAKAIO_CONFIG__ so the web UI can consume them at runtime rather
 * than relying on build-time constants or URL parsing.
 *
 * The bus runs in-process within the Electron host — there is no external
 * daemon connection to lose, so no reconnect signaling is needed.
 *
 * This is a CJS file because Electron preload scripts run in a sandboxed
 * context that does not support ESM `import` statements — only `require()`
 * of the `electron` module is available.
 */

const { contextBridge } = require('electron');

const BUS_URL_PREFIX = '--makaio-bus-url=';
const WINDOW_ID_PREFIX = '--makaio-window-id=';
const PACKAGE_NAME_PREFIX = '--makaio-package-name=';
const PARAMS_PREFIX = '--makaio-params=';
const BOOT_COMPLETE_FLAG = '--makaio-boot-complete';

/**
 * Extract a named argument value from process.argv injected via
 * additionalArguments.
 *
 * @param {string} prefix - The argument prefix to search for (e.g. `'--makaio-bus-url='`).
 * @returns {string | undefined} The value after the prefix, or undefined if not found.
 */
function parseArg(prefix) {
  for (let i = process.argv.length - 1; i >= 0; i -= 1) {
    if (process.argv[i].startsWith(prefix)) {
      return process.argv[i].slice(prefix.length);
    }
  }
  return undefined;
}

const busUrl = parseArg(BUS_URL_PREFIX);
const windowId = parseArg(WINDOW_ID_PREFIX);
const packageName = parseArg(PACKAGE_NAME_PREFIX);
const paramsRaw = parseArg(PARAMS_PREFIX);
const bootComplete = process.argv.includes(BOOT_COMPLETE_FLAG);

/** @type {Record<string, string> | undefined} */
let params;
if (paramsRaw) {
  try {
    params = JSON.parse(decodeURIComponent(paramsRaw));
  } catch {
    // Malformed params — ignore.
  }
}

// Always expose __MAKAIO_CONFIG__ — the renderer needs windowId even when
// busUrl comes from the Vite define constant (dev server mode).
contextBridge.exposeInMainWorld('__MAKAIO_CONFIG__', {
  ...(busUrl && { busUrl }),
  ...(windowId && { windowId }),
  ...(packageName && { packageName }),
  ...(params && { params }),
  ...(bootComplete && { bootComplete }),
});
