import type { MakaioExtension } from '@makaio/contracts';
import { CanonicalModelService } from './canonical-model-service.js';

/**
 * MakaioExtension manifest for {@link CanonicalModelService}.
 *
 * Canonical model resolution is surface-agnostic and framework-owned.
 */
export const canonicalModelPackage: MakaioExtension = {
  name: 'makaio.canonical-model',
  displayName: 'Canonical Model',
  version: '0.1.0',
  critical: false,
  /**
   * Creates a new {@link CanonicalModelService} bound to the package bus.
   * @param ctx - Runtime context providing the bus instance
   * @returns Uninitialized service instance; host calls `init()`
   */
  create: (ctx) => new CanonicalModelService(ctx.bus),
};
