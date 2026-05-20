/**
 * Minimal-config desktop E2E smoke test for the Electrobun host.
 */

import { describe, it } from 'vitest';
import { runMakaioDevDesktopSmoke } from './desktop-smoke-contract.js';
import { startElectrobun } from './spawn-electrobun.js';

describe('Electrobun desktop smoke test', { timeout: 220_000 }, () => {
  it('boots, opens a window, mounts the renderer, and shuts down cleanly', async () => {
    await runMakaioDevDesktopSmoke({
      expectedExtensionName: 'framework-shell',
      expectedRegistrationId: 'framework-shell:main',
      expectedUiSurface: 'electrobun',
      hostLabel: 'electrobun',
      startHost: startElectrobun,
    });
  });
});
