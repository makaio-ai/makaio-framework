import type { MakaioExtension } from '@makaio/contracts';

/**
 * Framework-level window registration for the dashboard shell.
 *
 * In framework-only mode (no host extension), this is the only window
 * in the registry and becomes the default Electron window. When the host
 * extension is loaded, the host can choose its own default window and
 * this window remains available as a fallback.
 */
export const frameworkShellWindowPackage: MakaioExtension = {
  name: 'framework-shell',
  displayName: 'Shell',
  surface: 'interactive',
  windows: [
    {
      id: 'main',
      style: 'utility',
      width: 1000,
      height: 700,
      singleton: true,
    },
  ],
};
