import type { IMakaioBus } from '@makaio/bus-core';
import { DEFAULT_CONSTRAINTS, dep, extensionToken, type MakaioNodeExtension } from '@makaio/contracts';
import { SubagentService } from './subagent-service.js';

/** Token for the framework subagent orchestration service. */
export const SubagentServiceToken = extensionToken<SubagentService>('subagent-service');

/**
 * MakaioNodeExtension<IMakaioBus> manifest for {@link SubagentService}.
 *
 * Subagent orchestration runs in headless mode — it does not require a UI
 * shell but does require the node runtime for process management.
 * The services-core manifest intentionally uses a service-specific export
 * name; `@makaio/extension-subagent` continues to own the tool-extension
 * `subagentPackage` export.
 * @param requestHandlerPriority - Priority for runtime-owned lifecycle RPC handlers.
 * @returns A subagent service package configured with the requested dispatch priority.
 */
export function createSubagentServicePackage(requestHandlerPriority = 0): MakaioNodeExtension<IMakaioBus> {
  return {
    name: SubagentServiceToken.name,
    displayName: 'Subagent Service',
    version: '0.1.0',
    critical: true,
    surface: 'headless',
    dependencies: [dep('session')],
    /**
     * Creates a new {@link SubagentService} bound to the package bus.
     *
     * The machine ID from the extension context is forwarded for adapter resolution.
     * @param ctx - Runtime context providing the bus instance and machine identity.
     * @returns Uninitialized service instance; host calls `init()`.
     */
    create: (ctx) =>
      new SubagentService(ctx.bus, DEFAULT_CONSTRAINTS, ctx.machineId, new Set(), requestHandlerPriority),
  };
}

export const subagentServicePackage: MakaioNodeExtension<IMakaioBus> = createSubagentServicePackage();
