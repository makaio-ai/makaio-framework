import type { IMakaioBus } from '@makaio/bus-core';
import { extensionToken, type MakaioNodeExtension } from '@makaio/contracts';
import { CapabilityService } from './capability-service.js';

/** Token for the capability registry service. */
export const CapabilityToken = extensionToken<CapabilityService>('capability');

/**
 * Package that starts the framework capability registry.
 *
 * The token and package live with the service rather than in the aggregate
 * package list so that a domain depending on the capability registry can
 * resolve the token without importing every other framework package.
 */
export const capabilityPackage: MakaioNodeExtension<IMakaioBus> = {
  name: CapabilityToken.name,
  displayName: 'Capability',
  version: '0.1.0',
  critical: true,
  /**
   * Creates a new {@link CapabilityService} bound to the package bus.
   * @param ctx - Runtime context providing the bus instance.
   * @returns Uninitialized service instance; host calls `init()`.
   */
  create: (ctx) => new CapabilityService(ctx.bus),
};
