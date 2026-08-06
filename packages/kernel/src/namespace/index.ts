/**
 * Kernel namespace definition.
 *
 * Defines the kernel subjects for explicit registration by composition roots.
 */
import { createBusNamespace } from '@makaio/core';
import { KernelSchemas } from './kernel-schemas.js';

export { KernelSchemas } from './kernel-schemas.js';

/**
 * Kernel namespace for bus operations.
 */
export const KernelNamespace = createBusNamespace('kernel', KernelSchemas);

/**
 * Kernel subjects for type-safe bus operations.
 *
 * Subjects:
 * - isReady: Probe kernel readiness state (RPC)
 * - phase.busCreated: Signal that the bus has been created (event)
 * - phase.coreReady: Signal that bus, config, and runtime-host resource handlers are ready (event)
 * - phase.servicesReady: Signal that lifecycle wiring and lifecycle.start have completed (event)
 * - phase.coordinatorReady: Barrier after extension coordinator has started all packages (broadcast RPC)
 * - ready: Signal full kernel initialization complete (event)
 * - lifecycle.start: Observability hook — lifecycle wiring complete (RPC)
 * - lifecycle.shutdown: Observability hook — lifecycle shutdown complete (RPC)
 * - restart: Request a host restart (RPC)
 */
export const KernelSubjects = KernelNamespace.subjects;
