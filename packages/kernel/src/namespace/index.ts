/**
 * Kernel namespace definition and workflow trigger type registry.
 *
 * Defines the kernel subjects for explicit registration and provides
 * module-level state for the workflow trigger type registry.
 */
import { createBusNamespace } from '@makaio/core';
import type { IWorkflowTriggerTypeRegistry } from '@makaio/contracts';
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

let workflowTriggerTypeRegistry: IWorkflowTriggerTypeRegistry | undefined;

/**
 * Set the workflow trigger type registry reference.
 * @param value - Workflow trigger type registry instance or undefined.
 */
export function setWorkflowTriggerTypeRegistry(value: IWorkflowTriggerTypeRegistry | undefined): void {
  if (value !== undefined && workflowTriggerTypeRegistry !== undefined && workflowTriggerTypeRegistry !== value) {
    throw new Error(
      'Workflow trigger type registry is already set. Clear it with setWorkflowTriggerTypeRegistry(undefined) before replacing it.',
    );
  }
  workflowTriggerTypeRegistry = value;
}

/**
 * Get the workflow trigger type registry reference.
 * @returns Workflow trigger type registry instance or undefined.
 */
export function getWorkflowTriggerTypeRegistry(): IWorkflowTriggerTypeRegistry | undefined {
  return workflowTriggerTypeRegistry;
}
