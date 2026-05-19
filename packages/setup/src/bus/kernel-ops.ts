/**
 * Bus operation wrappers for kernel lifecycle management.
 *
 * Encapsulates kernel RPC calls used by the setup flow, keeping bus
 * subject access isolated from higher-level controllers.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { KernelSubjects } from '@makaio/kernel';

/**
 * Requests a kernel restart via the bus.
 *
 * The kernel restart subject allows remote callers (such as the setup
 * wizard) to ask the host process to shut down and restart. The host
 * decides whether to accept; a declined restart throws rather than
 * silently succeeding.
 * @param bus - The bus instance.
 * @param reason - Optional human-readable reason for the restart.
 * @throws If the host does not accept the restart request.
 */
export async function requestKernelRestart(bus: IMakaioBus, reason?: string): Promise<void> {
  const response = await bus.request(KernelSubjects.restart, { reason });

  if (!response.accepted) {
    throw new Error('Kernel restart was not accepted by the host');
  }
}
