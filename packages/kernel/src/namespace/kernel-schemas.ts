import { z } from 'zod';
import { localSubject } from '@makaio/bus-core';
import type { SchemaRecord } from '@makaio/core';

const phaseMachinePayload = z.object({
  machineId: z.string(),
});

/**
 * Kernel domain schemas.
 *
 * Provides subjects for kernel introspection and lifecycle signalling.
 * Plugin/extension discovery has moved to the `kernel:extension.*` namespace
 * served by the ExtensionCoordinator.
 */
export const KernelSchemas = {
  /**
   * Probe kernel readiness state.
   *
   * Subject: `kernel.isReady`
   * Type: Request (RPC)
   * Purpose: Allows clients that connect after startup to query readiness
   *          without waiting for the one-time `kernel.ready` event.
   */
  isReady: {
    request: z.object({}),
    response: z.object({
      ready: z.boolean(),
      machineId: z.string(),
    }),
  },

  /**
   * Signal that the bus has been created and is ready for use.
   *
   * Subject: `kernel.phase.busCreated`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted immediately after bus creation so early external observers
   *          (e.g., transport bridges) can attach before config or services start.
   */
  'phase.busCreated': phaseMachinePayload,

  /**
   * Signal that the bus, config service, and runtime-host resource handlers are ready.
   *
   * Subject: `kernel.phase.coreReady`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted after bus creation, config service registration, and runtime
   *          resource provider registration — before lifecycle wiring begins.
   *          External transports (e.g., WebSocket bus server) hook in here so they
   *          have bus and machine identity but are available before full service readiness.
   */
  'phase.coreReady': phaseMachinePayload,

  /**
   * Signal that lifecycle wiring and lifecycle.start have completed.
   *
   * Subject: `kernel.phase.servicesReady`
   * Type: Event (fire-and-forget)
   * Purpose: Emitted after `startLifecycleWiring` and `lifecycle.start` complete.
   *          All core services are registered and ready to handle requests at this point.
   */
  'phase.servicesReady': phaseMachinePayload,

  /**
   * Lifecycle barrier emitted after the extension coordinator has started all
   * loaded packages.
   *
   * Subject: `kernel.phase.coordinatorReady`
   * Type: Broadcast request
   * Purpose: Allows host-owned integrations to finish post-coordinator wiring
   *          before the kernel announces full readiness.
   */
  'phase.coordinatorReady': localSubject({
    request: phaseMachinePayload,
    response: z.object({}),
  }),

  /**
   * Signal that the kernel has completed initialization.
   *
   * Subject: `kernel.ready`
   * Type: Event (fire-and-forget)
   * Purpose: SharedWorker waits for this before considering the backend ready.
   *          Eliminates the handler registration race where tabs send requests
   *          before registerRuntimeHandlers() completes.
   */
  ready: phaseMachinePayload,

  /**
   * Notify observers that lifecycle wiring has completed.
   *
   * Subject: `kernel.lifecycle.start`
   * Type: Request (RPC)
   * Purpose: Used as an observability/synchronization hook.
   *          Package startup is performed by the extension coordinator, not by
   *          handlers on this subject.
   */
  'lifecycle.start': {
    request: z.object({ machineId: z.string() }),
    response: z.object({}),
  },

  /**
   * Notify observers that lifecycle wiring shutdown has completed.
   *
   * Subject: `kernel.lifecycle.shutdown`
   * Type: Request (RPC)
   * Purpose: Used as an observability/synchronization hook.
   *          Package teardown is performed by the extension coordinator, not by
   *          handlers on this subject.
   */
  'lifecycle.shutdown': {
    request: z.object({}),
    response: z.object({}),
  },
} satisfies SchemaRecord;
