import type { IMakaioBus } from '@makaio/bus-core';
import { dep, type MakaioNodeExtension } from '@makaio/contracts';
import { ADAPTER_SUBSYSTEM_PACKAGE_NAME } from '../adapter-subsystem/namespace.js';
import { CanonicalModelService } from './canonical-model-service.js';

/**
 * MakaioExtension manifest for {@link CanonicalModelService}.
 *
 * Canonical model resolution is surface-agnostic and framework-owned.
 *
 * The adapter subsystem is declared because the service awaits
 * `adapterSubsystem.ensureReady` in `onInit` — a hard request that fails when
 * the subsystem has not started yet. That ordering was previously only an
 * accident of the load order, which held until an unrelated dependency moved
 * the subsystem later in the graph; declaring it makes the requirement the
 * coordinator's to satisfy rather than the load list's to preserve.
 */
export const canonicalModelPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'makaio.canonical-model',
  displayName: 'Canonical Model',
  version: '0.1.0',
  dependencies: [dep(ADAPTER_SUBSYSTEM_PACKAGE_NAME)],
  critical: false,
  /**
   * Creates a new {@link CanonicalModelService} bound to the package bus.
   * @param ctx - Runtime context providing the bus instance
   * @returns Uninitialized service instance; host calls `init()`
   */
  create: (ctx) => new CanonicalModelService(ctx.bus),
};
