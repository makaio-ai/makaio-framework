/**
 * Makaio Dev desktop E2E smoke test for the secondary Electron host.
 */

import { describe, it } from 'vitest';
import { OPTIONAL_MAKAIO_DEV_DESKTOP_FAILURES, runMakaioDevDesktopSmoke } from '../desktop-smoke-contract.js';
import { startElectron } from './spawn.js';

describe('Electron desktop smoke test', { timeout: 200_000 }, () => {
  it('boots, opens a window, mounts the renderer, and shuts down cleanly', async () => {
    await runMakaioDevDesktopSmoke({
      allowedFailedServices: OPTIONAL_MAKAIO_DEV_DESKTOP_FAILURES,
      expectedUiSurface: 'electron',
      hostLabel: 'electron',
      startHost: startElectron,
    });
  });
});
