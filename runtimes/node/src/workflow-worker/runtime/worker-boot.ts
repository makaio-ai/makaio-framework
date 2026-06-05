import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport, HmacAuth } from '@makaio/bus-transport-websocket';
import { FrameworkContractNamespaces, FrameworkStorageNamespaces, type WorkflowWorkerBusAuth } from '@makaio/contracts';
import { McpServerBridgeService } from '@makaio/subsystem-mcp-http-server';
import { ToolRegistry } from '@makaio/services-core/tools';
import type { Toolset } from '@makaio/tools-core';
import type { WorkerContributions } from './worker-contributions.js';

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

/** Handle for worker-local services. */
export interface WorkerRuntimeHandle {
  /** Close worker-local services. */
  close(): Promise<void>;
}

/**
 * Boot an isolated bus instance for a workflow worker.
 *
 * Creates a fresh bus, registers framework contract namespaces, and
 * optionally connects a WebSocket client transport when `busUrl` is
 * provided.
 *
 * If `busAuth.kind === 'hmac'`, the HMAC secret is passed to the
 * transport for challenge/response authentication.
 * @param config - Bus connection configuration from the workflow worker config.
 * @returns A handle with the bus instance and a close method.
 */
export async function bootWorkerBus(config: {
  readonly busUrl?: string;
  readonly busAuth: WorkflowWorkerBusAuth;
}): Promise<WorkerBusHandle> {
  const bus = createBusInstance();
  bus.registerNamespaces(FrameworkContractNamespaces);
  bus.registerNamespaces(FrameworkStorageNamespaces);

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
  handle: WorkerBusHandle,
  contributions: WorkerContributions,
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
