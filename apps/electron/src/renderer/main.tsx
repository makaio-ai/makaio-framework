/**
 * Electron desktop surface bootstrap entry point.
 *
 * Loaded directly by `index.html` via `<script type="module" src="/src/renderer/main.tsx">`.
 * Electron remains responsible for reading `window.__MAKAIO_CONFIG__`; the
 * shared host renderer owns the direct-WebSocket bootstrap after normalization.
 * @packageDocumentation
 */
import type { SurfaceType } from '@makaio/contracts';
import { startRenderer } from '@makaio/host-shared/renderer';
import { readElectronRendererConfig } from './config.js';
// Resolved via sharedRendererAliases in vite.renderer.config.ts, not a local file.
import './main.scss';

/** Electron-host surfaces: the main dashboard or the lightweight tray popover. */
type ElectronSurface = Extract<SurfaceType, 'electron' | 'tray'>;

/**
 * Read the `?surface` query parameter from the current window URL.
 *
 * Returns `'tray'` when the tray popover loads the SPA with `?surface=tray`,
 * otherwise returns `'electron'` as the default dashboard surface. Unknown
 * values fall through to `'electron'` — never an unchecked cast. This is the
 * renderer-side consumer of the surface hint injected by {@link buildTrayUrl}
 * in `tray-popover.ts`.
 * @returns Narrowed surface identifier.
 */
function readSurfaceHint(): ElectronSurface {
  try {
    const param = new URLSearchParams(window.location.search).get('surface');
    if (param === 'tray') return 'tray';
    return 'electron';
  } catch {
    return 'electron';
  }
}

void startRenderer({
  config: readElectronRendererConfig(__MAKAIO_BUS_URL__),
  logPrefix: 'electron-ui',
  surface: readSurfaceHint(),
});
