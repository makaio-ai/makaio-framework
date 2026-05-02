import type { NormalizedRendererConfig } from '@makaio/host-shared/renderer';

interface ElectronRuntimeConfig {
  readonly bootComplete?: boolean;
  readonly busUrl?: string;
  readonly params?: Record<string, string>;
  readonly windowId?: string;
}

/**
 * Read and normalize the Electron renderer config injected by the preload.
 * @param fallbackBusUrl - Build-time fallback bus URL from Vite.
 * @returns Normalized shared renderer config.
 */
export function readElectronRendererConfig(fallbackBusUrl: string): NormalizedRendererConfig {
  const config: ElectronRuntimeConfig = window.__MAKAIO_CONFIG__ ?? {};

  return {
    bootComplete: config.bootComplete ?? false,
    busUrl: config.busUrl ?? fallbackBusUrl,
    projectId: config.params?.projectId ?? null,
    windowId: config.windowId ?? null,
  };
}
