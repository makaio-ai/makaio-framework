import type { RegistrableBusNamespaceDefinition } from '@makaio/core';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  WorkflowNamespace,
  type OrderedWorkerBootstrapAuth,
  type WorkflowWorkerBusAuth,
  type JsonValue,
} from '@makaio/contracts';
import { McpServerBridgeService } from '@makaio/subsystem-mcp-http-server';
import { ToolRegistry } from '@makaio/services-core/tools';
import type { WorkerRuntimeContributions } from './worker-contributions.js';
import { createWorkerBusAuth } from '../worker-bus-auth.js';
import { WorkerExchangeClient, type WorkerExchangeSessionCheck } from './worker-exchange-client.js';

/** Explicit session owner for the local exchange composition. */
type WorkerSessionComposition = {
  check(bus: IMakaioBus): WorkerExchangeSessionCheck;
  onTerminal(error: unknown): void;
};

/** Synchronously acquired connection ownership, including an unfinished connect. */
export interface BootstrapRuntimeConnection {
  /** Fresh isolated bus, owned until close or successful transfer. */
  readonly bus: IMakaioBus;
  /** Committed order returned by the optional bootstrap exchange. */
  readonly bootstrapPayload?: JsonValue | undefined;
  /**
   * Connect authentication and subscription readiness.
   * @param signal - Cancellation of this pre-registration connection phase.
   */
  connect(signal: AbortSignal): Promise<void>;
  /** Revoke this session, including an unfinished connection. */
  close(): void | Promise<void>;
}

/**
 * Handle returned by {@link bootWorkerBus} representing an active
 * worker bus connection.
 */
export interface WorkerRuntimeBusHandle {
  /** The isolated bus instance for this worker. */
  bus: IMakaioBus;
  /** Committed order returned by the optional bootstrap exchange. */
  readonly bootstrapPayload?: JsonValue | undefined;
  /** Disconnect the bus and release resources. */
  close(): void | Promise<void>;
}

/** Handle for worker-local services. */
export interface WorkerRuntimeHandle {
  /** Close worker-local services. */
  close(): Promise<void>;
}

/**
 * Acquire an isolated bus connection handle before asynchronous bootstrap begins.
 *
 * Creates a fresh bus, registers framework contract namespaces, and
 * optionally installs a WebSocket client transport when `busUrl` is
 * provided. The caller owns cleanup before invoking `connect`.
 *
 * If `busAuth.kind === 'hmac'`, the HMAC secret is passed to the
 * transport for challenge/response authentication. An `identityId` turns that
 * handshake identity-bound, so the server resolves a trusted peer context for
 * the socket instead of authenticating it against the process-global secret.
 * The host owns the credential's identity and its authenticated claims.
 * @param config - Bus connection configuration from the workflow worker config.
 * @param sessions - Worker composer policy for the synchronized owner check.
 * @returns A handle with the bus instance, connect and close methods.
 */
export function createWorkerBus(
  config: {
    readonly busUrl?: string;
    readonly busAuth: WorkflowWorkerBusAuth | OrderedWorkerBootstrapAuth;
    readonly identityId?: string;
    readonly namespaces?: readonly RegistrableBusNamespaceDefinition[];
  },
  sessions?: WorkerSessionComposition,
): BootstrapRuntimeConnection {
  const bus = createBusInstance();
  // The worker hosts the workflow contract locally without loading the workflow engine extension.
  bus.registerNamespaces([...FrameworkContractNamespaces, WorkflowNamespace]);
  bus.registerNamespaces([...FrameworkStorageNamespaces, ...(config.namespaces ?? [])]);

  if (!config.busUrl && config.busAuth.kind !== 'exchange') {
    return {
      bus,
      connect: async (signal) => signal.throwIfAborted(),
      close: () => bus.disconnect(),
    };
  }

  const transport =
    config.busAuth.kind === 'exchange'
      ? new WorkerExchangeClient(config.busUrl, config.busAuth, sessions?.check(bus), sessions?.onTerminal)
      : new WebSocketClientTransport({
          url: config.busUrl ?? '',
          attestingRole: 'core-uplink',
          auth: createWorkerBusAuth(
            config.busAuth.kind === 'hmac' ? config.busAuth.secret : undefined,
            config.identityId,
          ),
          autoReconnect: false,
        });

  bus.registerTransport(transport);
  return {
    bus,
    get bootstrapPayload() {
      return transport instanceof WorkerExchangeClient ? transport.bootstrapPayload : undefined;
    },
    async connect(signal) {
      try {
        signal.throwIfAborted();
        const onAbort = (): void => bus.disconnect();
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          await bus.connect();
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
        signal.throwIfAborted();
      } catch (error) {
        bus.disconnect();
        throw error;
      }
    },
    async close() {
      await bus.disconnect();
    },
  };
}

/**
 * Acquire and connect an unbound worker bus without an Attempt bootstrap budget.
 * @param config - Bus location and optional authenticated identity.
 * @param signal - Caller cancellation.
 * @returns The connected worker bus and its cleanup handle.
 */
export async function bootWorkerBus(
  config: Parameters<typeof createWorkerBus>[0],
  signal: AbortSignal = new AbortController().signal,
): Promise<WorkerRuntimeBusHandle> {
  const handle = createWorkerBus(config);
  try {
    await handle.connect(signal);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Boot worker-local tool runtime pieces from loaded contributions.
 *
 * Registers contribution toolsets in a local {@link ToolRegistry} backed by an
 * MCP server bridge, keeping adapter `ToolSubjects.execute` calls inside the
 * worker. Agent steps spawn subagents to the host (see {@link runWorkflowInWorker}),
 * so no worker-local adapter runtime is created here.
 * @param handle - Active worker bus handle.
 * @param contributions - Toolset contributions loaded from the manifest.
 * @returns Runtime handle that closes all worker-local resources.
 */
export async function bootWorkerRuntime(
  handle: WorkerRuntimeBusHandle,
  contributions: WorkerRuntimeContributions,
): Promise<WorkerRuntimeHandle> {
  const toolRegistry = new ToolRegistry({ bus: handle.bus });
  const mcpBridge = new McpServerBridgeService(handle.bus);

  const closeRuntime = async (): Promise<void> => {
    try {
      await mcpBridge.destroy();
    } finally {
      toolRegistry.dispose();
    }
  };

  try {
    await mcpBridge.init();

    for (const { toolset, bus } of contributions.toolsets) {
      await toolRegistry.register(toolset, { bus });
    }
  } catch (error) {
    await closeRuntime();
    throw error;
  }

  return { close: closeRuntime };
}
