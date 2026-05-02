import type { IMakaioBus } from '@makaio/bus-core';
import { PlatformSubjects, type IAutoLaunchProvider } from '@makaio/contracts';

/**
 * Register bus handlers that bridge `platform.autoLaunch.*` subjects
 * to the given provider.
 * @param bus - The Makaio bus instance.
 * @param provider - The auto-launch capability provider.
 * @returns Cleanup function that unregisters all handlers.
 */
export function registerAutoLaunchHandlers(bus: IMakaioBus, provider: IAutoLaunchProvider): () => void {
  const cleanupEnable = bus.on(PlatformSubjects.autoLaunch.enable, async (ctx) => {
    const result = await provider.enable(ctx.payload.hidden);
    ctx.setResult(result);
  });

  const cleanupDisable = bus.on(PlatformSubjects.autoLaunch.disable, async (ctx) => {
    const result = await provider.disable();
    ctx.setResult(result);
  });

  const cleanupStatus = bus.on(PlatformSubjects.autoLaunch.getStatus, async (ctx) => {
    const result = await provider.getStatus();
    ctx.setResult(result);
  });

  return () => {
    cleanupEnable();
    cleanupDisable();
    cleanupStatus();
  };
}
