import type { IMakaioBus } from '@makaio/bus-core';
import type { TransportProvider } from './transport.js';

/**
 * No-op transport provider for in-process-only bus usage.
 * Used by framework users who don't need cross-process communication.
 */
export class NoTransportProvider implements TransportProvider {
  /**
   * No-op — no transport to connect.
   * @param _bus - Unused bus instance.
   * @param _machineId - Unused machine identifier.
   */
  public async connect(_bus: IMakaioBus, _machineId: string): Promise<void> {}

  /** Nothing to disconnect. */
  public async disconnect(): Promise<void> {}
}
