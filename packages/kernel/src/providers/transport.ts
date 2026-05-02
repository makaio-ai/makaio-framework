import type { IMakaioBus } from '@makaio/bus-core';

/**
 * Platform-specific bus transport (WebSocket server, client, none).
 */
export interface TransportProvider {
  /**
   * Attach transport to the bus.
   *
   * For server transports, the HTTP server and Hono app are passed via
   * constructor options — the provider only wires the WebSocket upgrade
   * handler onto them.
   * @param bus - Bus instance to attach transport to.
   * @param machineId - Machine identifier for transport identification.
   */
  connect(bus: IMakaioBus, machineId: string): Promise<void>;

  /** Disconnect and release transport resources. */
  disconnect(): Promise<void>;
}
