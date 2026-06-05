import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport, HmacAuth } from '@makaio/bus-transport-websocket';
import {
  AdapterSubjects,
  AgentSubjects,
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
  ToolSubjects,
  type AdapterContribution,
  type WorkflowWorkerBusAuth,
} from '@makaio/contracts';
import { McpServerBridgeService } from '@makaio/subsystem-mcp-http-server';
import { ToolRegistry } from '@makaio/services-core/tools';
import type { Toolset } from '@makaio/tools-core';
import type { WorkerContributions } from './worker-contributions.js';

/** Platform defaults supplied to worker-local adapter factories. */
export interface WorkerRuntimePlatformDefaults {
  /** Working directory for worker-local shell and tool execution. */
  readonly cwd: string;
  /** Optional environment variables visible to worker-local adapters. */
  readonly env?: Record<string, string>;
}

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

/** Handle for worker-local services and adapter instances. */
export interface WorkerRuntimeHandle {
  /** Adapter identifiers initialized inside this worker runtime. */
  readonly adapterIds: readonly string[];
  /** Close worker-local services and adapter instances. */
  close(): Promise<void>;
}

/** Minimal adapter lifecycle surface needed by isolated worker boot. */
interface WorkerLocalAdapter {
  /** Initialize bus handlers when the factory returns an uninitialized adapter. */
  init?: () => void | Promise<void>;
  /** Preferred async cleanup hook used by framework adapters. */
  closeAsync?: () => void | Promise<void>;
  /** Synchronous cleanup fallback used by structural test adapters. */
  close?: () => void | Promise<void>;
}

/** Runtime options passed to adapter factories inside workers. */
interface WorkerAdapterInitOptions {
  /** Adapter instance ID used for local adapter routing. */
  adapterId: string;
  /** Worker-local bus instance. */
  globalBus: IMakaioBus;
  /** Worker platform defaults from the workflow worker config. */
  platformDefaults: WorkerRuntimePlatformDefaults;
  /** Subject tokens exposed for structural worker test adapters and lightweight adapters. */
  adapterSubjects: typeof AdapterSubjects;
  /** Subject tokens exposed for structural worker test adapters and lightweight adapters. */
  agentSubjects: typeof AgentSubjects;
  /** Subject tokens exposed for structural worker test adapters and lightweight adapters. */
  toolSubjects: typeof ToolSubjects;
}

/** Adapter definition narrowed to the worker-local factory options. */
interface WorkerAdapterDefinition {
  /** Adapter name used when no manifest name is present. */
  name: string;
  /** Create a worker-local adapter instance. */
  createAdapter(options?: WorkerAdapterInitOptions): Promise<WorkerLocalAdapter>;
}

/**
 * Narrow an adapter contribution definition to the worker-local factory shape.
 * @param contribution - Adapter contribution loaded from the worker manifest.
 * @returns Adapter definition with worker-local factory options.
 */
function getWorkerAdapterDefinition(contribution: AdapterContribution): WorkerAdapterDefinition {
  return contribution.definition as WorkerAdapterDefinition;
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
 * Boot worker-local tool and adapter runtime pieces from loaded contributions.
 *
 * Registers contribution toolsets in a local {@link ToolRegistry}, then creates
 * and initializes contribution adapters against the same isolated bus. This
 * keeps adapter `ToolSubjects.execute` calls inside the worker instead of
 * routing them back through host subagent orchestration.
 * @param handle - Active worker bus handle.
 * @param contributions - Toolset and adapter contributions loaded from the manifest.
 * @param platformDefaults - Platform defaults supplied by the workflow worker config.
 * @returns Runtime handle that closes all worker-local resources.
 */
export async function bootWorkerRuntime(
  handle: WorkerBusHandle,
  contributions: WorkerContributions,
  platformDefaults: WorkerRuntimePlatformDefaults,
): Promise<WorkerRuntimeHandle> {
  const toolRegistry = new ToolRegistry({ bus: handle.bus });
  const mcpBridge = new McpServerBridgeService(handle.bus);
  const adapters: WorkerLocalAdapter[] = [];
  const adapterIds: string[] = [];

  const closeRuntime = async (): Promise<void> => {
    const adapterCloseResults = await Promise.allSettled(
      adapters
        .slice()
        .reverse()
        .map(async (adapter) => closeWorkerAdapter(adapter)),
    );
    let mcpBridgeError: unknown;
    try {
      await mcpBridge.destroy();
    } catch (error) {
      mcpBridgeError = error;
    } finally {
      toolRegistry.dispose();
    }

    const closeErrors = adapterCloseResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (mcpBridgeError !== undefined) closeErrors.push(mcpBridgeError);
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, `Failed to close ${closeErrors.length} worker runtime resource(s).`);
    }
  };

  try {
    await mcpBridge.init();

    for (const toolset of contributions.toolsets) {
      await registerWorkerToolset(toolRegistry, toolset);
    }

    for (const contribution of contributions.adapters) {
      const definition = getWorkerAdapterDefinition(contribution);
      const adapterId = contribution.manifest.name || definition.name;
      const adapter = await definition.createAdapter({
        adapterId,
        globalBus: handle.bus,
        platformDefaults,
        adapterSubjects: AdapterSubjects,
        agentSubjects: AgentSubjects,
        toolSubjects: ToolSubjects,
      });
      adapters.push(adapter);
      await adapter.init?.();
      adapterIds.push(adapterId);
    }
  } catch (error) {
    await closeRuntime();
    throw error;
  }

  return { adapterIds, close: closeRuntime };
}

/**
 * Register one worker-local toolset.
 * @param registry - Worker-local tool registry.
 * @param toolset - Toolset loaded from the worker manifest.
 */
async function registerWorkerToolset(registry: ToolRegistry, toolset: Toolset): Promise<void> {
  await registry.register(toolset);
}

/**
 * Close a worker-local adapter through its supported lifecycle hook.
 * @param adapter - Adapter instance returned by a contribution factory.
 */
async function closeWorkerAdapter(adapter: WorkerLocalAdapter): Promise<void> {
  if (adapter.closeAsync) {
    await adapter.closeAsync();
    return;
  }

  await adapter.close?.();
}
