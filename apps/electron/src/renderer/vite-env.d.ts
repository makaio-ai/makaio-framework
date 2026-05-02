/// <reference types="vite/client" />

/**
 * Vite-injected globals defined in vite.renderer.config.ts via `define`.
 */
declare const __MAKAIO_BUS_URL__: string;
declare const __VITE_SERVER_START__: string;

/**
 * Globals injected by the Electron main process when the bootstrap
 * window navigates to the electron-ui surface.
 */
interface Window {
  /**
   * Runtime configuration injected by the Electron main process after load.
   * Contains the bus WebSocket URL that overrides the build-time
   * `__MAKAIO_BUS_URL__` constant (which is intentionally empty for
   * electron-ui since the URL is always injected at runtime).
   */
  __MAKAIO_CONFIG__?: {
    busUrl?: string;
    /**
     * Qualified window registration ID (`{packageName}:{windowId}`).
     * Set by the main process via `--makaio-window-id`.
     */
    windowId?: string;
    /**
     * Package name that owns this window.
     * Set by the main process via `--makaio-package-name`.
     */
    packageName?: string;
    params?: Record<string, string>;
    /** When true, service boot has already completed — skip waitForServiceBoot. */
    bootComplete?: boolean;
  };
}
