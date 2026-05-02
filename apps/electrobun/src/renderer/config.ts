import type { NormalizedRendererConfig } from '@makaio/host-shared/renderer';

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
