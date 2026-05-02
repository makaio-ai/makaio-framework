/**
 * Browser-side navigation handler registration.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { UiSubjects, deriveBrowserTarget } from '@makaio/ui-kernel';

/** Protocols that are safe to pass to `window.open`. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Registers the browser-side navigation handler at priority 10.
 *
 * This handler validates the URL scheme, then performs `window.open()` with
 * target names derived from the URL for singleton/reuse semantics. Only
 * `http:` and `https:` URLs are allowed — `javascript:` and other unsafe
 * schemes throw to prevent XSS via the bus.
 *
 * In Electron, the higher-priority main-process handler (priority 100)
 * intercepts first; this handler acts as the fallback.
 * @param bus - The MakaioBus instance to register on
 * @returns Cleanup function that unregisters the handler
 */
export function registerNavigationHandler(bus: IMakaioBus): () => void {
  return bus.on(
    UiSubjects.navigate,
    (ctx) => {
      const { url } = ctx.payload;

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url, window.location.href);
      } catch {
        throw new Error(`[registerNavigationHandler] Invalid URL: ${url}`);
      }

      if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
        throw new Error(`[registerNavigationHandler] Unsafe URL protocol "${parsedUrl.protocol}" in: ${url}`);
      }

      const safeUrl = parsedUrl.toString();
      // deriveBrowserTarget expects a path-relative string (not a full origin),
      // so pass the pathname+search+hash portion for correct segment matching.
      const pathForTarget = parsedUrl.pathname + parsedUrl.search + parsedUrl.hash;
      const target = deriveBrowserTarget(pathForTarget);
      window.open(safeUrl, target, 'noopener,noreferrer');
      ctx.setResult({ action: 'navigated' });
    },
    { priority: 10 },
  );
}
