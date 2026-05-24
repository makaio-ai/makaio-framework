import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport, HmacAuth } from '@makaio/bus-transport-websocket';
import { FrameworkContractNamespaces, type StepRunConfig } from '@makaio/contracts';

/**
 * Handle returned by {@link bootWorkerBus} representing an active
 * worker bus connection.
 */
export interface WorkerBusHandle {
  /** The isolated bus instance for this worker. */
  bus: IMakaioBus;
  /** Disconnect the bus and release resources. */
  close(): void | Promise<void>;
}

/**
 * Boot an isolated bus instance for a step runner worker.
 *
 * Creates a fresh bus, registers framework contract namespaces, and
 * optionally connects a WebSocket client transport when `busUrl` is
 * provided.
 *
 * If `busAuth.kind === 'hmac'`, the HMAC secret is passed to the
 * transport for challenge/response authentication.
 * @param config - Bus connection configuration (busUrl and busAuth fields from StepRunConfig).
 * @returns A handle with the bus instance and a close method.
 */
export async function bootWorkerBus(config: Pick<StepRunConfig, 'busUrl' | 'busAuth'>): Promise<WorkerBusHandle> {
  const bus = createBusInstance();
  bus.registerNamespaces(FrameworkContractNamespaces);

  if (!config.busUrl) {
    return {
      bus,
      close() {
        // No transport to disconnect; nothing to do.
      },
    };
  }

  const auth = config.busAuth.kind === 'hmac' ? new HmacAuth({ secret: config.busAuth.secret }) : undefined;

  const transport = new WebSocketClientTransport({
    url: config.busUrl,
    auth,
    autoReconnect: false,
  });

  bus.registerTransport(transport);
  await bus.connect();

  return {
    bus,
    async close() {
      await bus.disconnect();
    },
  };
}
