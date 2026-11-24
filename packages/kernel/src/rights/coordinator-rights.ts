import type { BoundaryAccessCheck, IMakaioBus } from '@makaio/bus-core';
import { createBoundaryAccessCheck, type BoundaryPhase } from './boundary-access.js';
import { registerRightsHandlers } from './rights-handlers.js';
import { createRefusedRightsHub, createRightsHub, type RightsHub } from './rights-hub.js';

/** Rights surfaces needed by the extension coordinator and its host. */
export type CoordinatorRights = Pick<RightsHub, 'capabilityFor' | 'beginActivation' | 'activate' | 'deactivate'> & {
  /** Register this host's rights request handlers. */
  registerHandlers(): Array<() => void>;
  /** Admit external operations after startup. */
  openBoundary(): void;
  /** Close external admission for the lifetime of this host. */
  closeBoundary(): void;
  /** Whether all startup contributions are installed. */
  isBoundaryReady(): boolean;
  /** Check an operation at the transport boundary. */
  readonly checkBoundaryAccess: BoundaryAccessCheck;
};

/**
 * Supply the lifecycle, request handlers and transport policy of one coordinator.
 * @param bus - The coordinator's host bus.
 * @param mode - Whether this composition owns host rights.
 * @returns The coordinator's rights surfaces, sharing one resolver.
 */
export function createCoordinatorRights(bus: IMakaioBus, mode: 'host' | 'refused' | undefined): CoordinatorRights {
  const ownsRights = mode !== 'refused';
  const hub = ownsRights ? createRightsHub({ bus }) : createRefusedRightsHub();
  let phase: BoundaryPhase = 'starting';
  return {
    openBoundary: () => {
      if (phase === 'starting') phase = 'ready';
    },
    closeBoundary: () => {
      phase = 'closed';
    },
    isBoundaryReady: () => phase === 'ready',
    capabilityFor: hub.capabilityFor,
    beginActivation: hub.beginActivation,
    activate: hub.activate,
    deactivate: hub.deactivate,
    registerHandlers: () => (ownsRights ? registerRightsHandlers(bus, hub) : []),
    checkBoundaryAccess: createBoundaryAccessCheck(bus, hub, () => phase),
  };
}
