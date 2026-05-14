import { createBusNamespace } from '@makaio/core';
import { LifecycleSchemas, type ConnectedPayload, type DisconnectedPayload } from './lifecycle-schemas.js';

export type { ConnectedPayload, DisconnectedPayload };

const LifecycleNamespace = createBusNamespace('bus:lifecycle', LifecycleSchemas);

/**
 * Bus-level lifecycle subjects for subscribing to transport connection state changes.
 *
 * All subjects are local-only: they are never relayed across transports, as they
 * describe the local bus's own connection state.
 *
 * Registration happens per-context inside `createBus()`.
 * @example
 * ```typescript
 * import { BusLifecycle } from '@makaio/bus-core';
 *
 * MakaioBus.on(BusLifecycle.connected, ({ payload }) => {
 *   console.log('Transport connected:', payload.transport);
 * });
 *
 * MakaioBus.on(BusLifecycle.disconnected, ({ payload }) => {
 *   console.warn('Transport disconnected:', payload.transport);
 * });
 * ```
 */
export const BusLifecycle = LifecycleNamespace.subjects;
