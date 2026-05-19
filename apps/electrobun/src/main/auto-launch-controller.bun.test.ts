import { afterEach, describe, expect, it, mock } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { PlatformSubjects } from '@makaio/contracts';
import { createAutoLaunchController } from './auto-launch-controller.js';

describe('createAutoLaunchController', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('does not request enablement when auto-launch support is unavailable', async () => {
    let enableRequests = 0;
    cleanups.push(
      MakaioBus.on(PlatformSubjects.autoLaunch.enable, (ctx) => {
        enableRequests += 1;
        ctx.setResult({ enabled: true });
      }),
    );
    const refreshTrayMenu = mock();
    const controller = createAutoLaunchController({ refreshTrayMenu });

    await controller.refreshStatus();
    controller.toggle();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(controller.enabled).toBeNull();
    expect(enableRequests).toBe(0);
    expect(refreshTrayMenu).toHaveBeenCalledOnce();
  });
});
