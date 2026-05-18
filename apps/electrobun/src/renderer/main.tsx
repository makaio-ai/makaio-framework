/**
 * Electrobun desktop surface bootstrap entry point.
 *
 * Loaded directly by `index.html` via `<script type="module" src="/src/renderer/main.tsx">`.
 * Electrobun remains responsible for reading `window.location.search`; the
 * shared host renderer owns the direct-WebSocket bootstrap after normalization.
 * @packageDocumentation
 */
import { startRenderer } from '@makaio/host-shared/renderer';
import { readElectrobunRendererConfig, readElectrobunSurfaceHint } from './config.js';
// Resolved via sharedRendererAliases in vite.renderer.config.ts, not a local file.
import './main.scss';

void startRenderer({
  config: readElectrobunRendererConfig(__MAKAIO_BUS_URL__),
  logPrefix: 'electrobun-ui',
  surface: readElectrobunSurfaceHint(),
});
