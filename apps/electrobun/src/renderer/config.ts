import type { NormalizedRendererConfig } from '@makaio/host-shared/renderer';
import type { SurfaceType } from '@makaio/contracts';

/** Electrobun-host surfaces: the main dashboard or the lightweight tray popover. */
export type ElectrobunSurface = Extract<SurfaceType, 'electrobun' | 'tray'>;

/**
 * Read and normalize the Electrobun renderer config from URL query params.
 *
 * Keeps the standalone dev fallback bus URL derived from the current origin
 * when the host does not inject a `busUrl` query param.
 * @param fallbackBusUrl - Build-time fallback bus URL from Vite.
 * @returns Normalized shared renderer config.
 */
export function readElectrobunRendererConfig(fallbackBusUrl: string): NormalizedRendererConfig {
  const params = new URLSearchParams(window.location.search);
  const queryBusUrl = params.get('busUrl') ?? `ws://${window.location.host}/bus`;

  return {
    bootComplete: params.get('bootComplete') === '1',
    busUrl: queryBusUrl || fallbackBusUrl,
    projectId: params.get('projectId') || null,
    windowId: params.get('window') || null,
  };
}

/**
 * Read the `?surface` query parameter from the current window URL.
 *
 * Returns `'tray'` when the tray popover loads the SPA with `?surface=tray`,
 * otherwise returns `'electrobun'` as the default dashboard surface. Unknown
 * values fall through to `'electrobun'` so malformed URLs never escape the
 * declared surface contract.
 * @returns Narrowed Electrobun renderer surface identifier.
 */
export function readElectrobunSurfaceHint(): ElectrobunSurface {
  try {
    const param = new URLSearchParams(window.location.search).get('surface');
    if (param === 'tray') return 'tray';
    return 'electrobun';
  } catch {
    return 'electrobun';
  }
}
