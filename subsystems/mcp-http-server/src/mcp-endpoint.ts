/**
 * Everything an MCP endpoint owns apart from its request plumbing.
 *
 * The Node and fetch handlers differ in exactly one thing: which MCP SDK
 * transport class they instantiate per client session. Everything around that
 * — eager option validation, the adapter context registry, the process-level
 * fallback session ID, the transport registry, and the endpoint's idempotent
 * close gate — is identical, and duplicating it is how the two handlers drift
 * apart on session and error semantics. They share one construction path here
 * and contribute only their transport.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { IMakaioBus } from '@makaio/bus-core';
import { McpContextRegistry, type IMcpContextRegistry } from './context-registry.js';
import { createMcpServer } from './create-mcp-server.js';
import { once, onceAsync } from './mcp-server-lifecycle.js';
import { McpTransportRegistry, type McpSessionHooks } from './mcp-transport-registry.js';
import { validateToolExecutionTimeout } from './option-validation.js';
import type { HttpMcpHandlerOptions } from './server-options.js';

/**
 * Build one unconnected transport for a new MCP client session.
 *
 * The implementation must forward {@link McpSessionHooks.onSessionInitialized}
 * to the transport's `onsessioninitialized` option, which is the registry's
 * only admission point.
 */
export type CreateMcpTransport<T extends Transport> = (hooks: McpSessionHooks) => T;

/** The transport-independent half of an MCP HTTP endpoint. */
export interface McpEndpoint<T extends Transport> {
  /** Routes requests to the transport owning their MCP protocol session. */
  readonly registry: McpTransportRegistry<T>;
  /** Context registry for registering and unregistering adapter sessions. */
  readonly contextRegistry: IMcpContextRegistry;
  /**
   * Close every MCP client session and fire the caller's `onclose` once.
   *
   * Idempotent: repeated calls await the same underlying teardown.
   * @returns Promise resolving once teardown has settled.
   */
  close(): Promise<void>;
}

/**
 * Assemble the transport-independent half of an MCP HTTP endpoint.
 *
 * Sessions are built lazily, on the first request that opens one, so option
 * validation runs here rather than in the session factory: a misconfigured
 * endpoint must fail at creation time instead of surfacing as a 500 on
 * someone's first tool call.
 * @param bus - Bus instance for tool execution and approval RPC.
 * @param options - Handler options shared by both HTTP handler flavours.
 * @param createTransport - Builds the SDK transport for one client session.
 * @returns The endpoint's registry, context registry, and close gate.
 * @throws RangeError When a timeout or reaping duration option is out of range.
 */
export function createMcpEndpoint<T extends Transport>(
  bus: IMakaioBus,
  options: HttpMcpHandlerOptions,
  createTransport: CreateMcpTransport<T>,
): McpEndpoint<T> {
  validateToolExecutionTimeout(options.toolExecutionTimeoutMs);

  const contextRegistry = new McpContextRegistry();

  const sessionId = options.agentContext?.adapterSessionId ?? crypto.randomUUID();
  if (options.agentContext) {
    contextRegistry.register(sessionId, options.agentContext);
  }

  const registry = new McpTransportRegistry<T>({
    createSession: async (hooks) => {
      // Transport first: it owns no external resources yet, while
      // `createMcpServer` installs a `ToolSubjects.registryChanged` bus
      // subscription. In the reverse order a throwing transport factory would
      // strand a server the registry never saw and cannot close — leaking the
      // subscription on every failed initialization.
      const transport = createTransport(hooks);
      return {
        server: await createMcpServer(bus, sessionId, {
          contextRegistry,
          toolDiscovery: options.toolDiscovery,
          resolveContextOverrides: options.resolveContextOverrides,
          toolExecutionTimeoutMs: options.toolExecutionTimeoutMs,
        }),
        transport,
      };
    },
    idleTimeoutMs: options.idleTimeoutMs,
    sweepIntervalMs: options.sweepIntervalMs,
  });

  // `onclose` is endpoint-level: it reports that this endpoint stopped serving,
  // never that one client disconnected or terminated its own MCP session.
  // `finally` guarantees it even when a session teardown rejects.
  const fireOnce = once(options.onclose);

  return {
    registry,
    contextRegistry,
    close: onceAsync(() => registry.closeAll().finally(fireOnce)),
  };
}
