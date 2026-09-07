import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { FrameworkContractNamespaces, FrameworkStorageNamespaces, type WorkflowWorkerBusAuth } from '@makaio/contracts';
import { McpServerBridgeService } from '@makaio/subsystem-mcp-http-server';
import { ToolRegistry } from '@makaio/services-core/tools';
import type { Toolset } from '@makaio/tools-core';
import type { WorkerRuntimeContributions } from './worker-contributions.js';
import { createWorkerBusAuth } from '../worker-bus-auth.js';
import type { BootstrapRuntimeConnection } from '../bootstrap-start-client.js';

/**
 * Handle returned by {@link bootWorkerBus} representing an active
 * worker bus connection.
 */
export interface WorkerRuntimeBusHandle {
  /** The isolated bus instance for this worker. */
  bus: IMakaioBus;
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
 * Attempt-owned workers claim their `executionAttemptId` here, because the
 * Authority's attempt gates take their caller identity from that peer.
 * @param config - Bus connection configuration from the workflow worker config.
 * @returns A handle with the bus instance, connect and close methods.
 */
export function createWorkerBus(config: {
  readonly busUrl?: string;
  readonly busAuth: WorkflowWorkerBusAuth;
  readonly identityId?: string;
}): BootstrapRuntimeConnection {
  const bus = createBusInstance();
  bus.registerNamespaces(FrameworkContractNamespaces);
  bus.registerNamespaces(FrameworkStorageNamespaces);

  if (!config.busUrl) {
    return {
      bus,
      connect: async (signal) => signal.throwIfAborted(),
      close: () => bus.disconnect(),
    };
  }

  const auth = createWorkerBusAuth(
    config.busAuth.kind === 'hmac' ? config.busAuth.secret : undefined,
    config.identityId,
  );

  const transport = new WebSocketClientTransport({
    url: config.busUrl,
    auth,
    autoReconnect: false,
  });

  bus.registerTransport(transport);
  return {
    bus,
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

    for (const toolset of contributions.toolsets) {
      await registerWorkerToolset(toolRegistry, toolset);
    }
  } catch (error) {
    await closeRuntime();
    throw error;
  }

  return { close: closeRuntime };
}

/**
 * Register one worker-local toolset.
 * @param registry - Worker-local tool registry.
 * @param toolset - Toolset loaded from the worker manifest.
 */
async function registerWorkerToolset(registry: ToolRegistry, toolset: Toolset): Promise<void> {
  await registry.register(toolset);
}
