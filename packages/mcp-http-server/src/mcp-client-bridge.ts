import type { IMakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import {
  ToolErrorCodes,
  errorToToolResult,
  toolError,
  toolSuccess,
  type ToolInfo,
  type ToolResult,
} from '@makaio/tools-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * A tool discovered from an MCP server and bridged for bus registration.
 */
export interface McpBridgedTool {
  /** The tool's name as returned by the MCP server. */
  readonly name: string;
  /** Human-readable description. */
  readonly description: string;
  /** JSON Schema for the tool's input parameters. */
  readonly inputSchema: unknown;
}

/**
 * Return type of {@link McpClientBridgeHandle.callTool}.
 *
 * Mirrors the shape returned by the MCP SDK client so callers get the raw
 * result without re-parsing content.
 */
export type McpCallToolResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * Handle for an active MCP client bridge.
 *
 * Returned by {@link startMcpClientBridge}. Callers hold this handle for the
 * lifetime of the spawned MCP subprocess, then call {@link close} to tear down
 * the transport and the child process.
 */
export interface McpClientBridgeHandle {
  /**
   * Currently known tools from the MCP server.
   *
   * Updated automatically whenever the server sends
   * `notifications/tools/list_changed` (requires
   * {@link McpClientBridgeOptions.onToolsChanged} to be provided so the bridge
   * subscribes to list-change events).
   */
  readonly tools: readonly McpBridgedTool[];
  /**
   * Names of the currently known tools.
   *
   * Convenience accessor over {@link tools} — equivalent to
   * `handle.tools.map(t => t.name)`.
   */
  readonly toolNames: readonly string[];
  /**
   * Proxy a tool call to the connected MCP server.
   * @param name - Tool name as advertised by the MCP server.
   * @param args - Tool input arguments.
   * @returns The raw MCP call-tool result.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
  /**
   * Close the MCP client and terminate the subprocess.
   * @returns Promise that resolves when the transport has been fully closed.
   */
  close(): Promise<void>;
}

/**
 * Options for {@link startMcpClientBridge}.
 */
export interface McpClientBridgeOptions {
  /**
   * The executable to spawn as an MCP server subprocess.
   *
   * Can be an absolute path or a name resolvable via `PATH`.
   */
  readonly command: string;
  /**
   * Command-line arguments forwarded to the subprocess.
   * Defaults to an empty array when omitted.
   */
  readonly args?: readonly string[];
  /**
   * Environment variables for the spawned subprocess.
   *
   * When omitted the SDK's {@link getDefaultEnvironment} is used, which
   * inherits a safe subset of the parent environment.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Working directory for the spawned subprocess.
   *
   * Forwarded verbatim to the stdio transport. When omitted, the current
   * working directory of the parent process is inherited.
   */
  readonly cwd?: string;
  /**
   * Extension name used as the MCP client identifier.
   *
   * Surfaced as `name: 'makaio-{extensionName}'` in the MCP handshake, making
   * server-side logs attributable to the correct extension.
   */
  readonly extensionName: string;
  /**
   * Callback invoked when the MCP server signals that its tool list has changed.
   *
   * Receives the refreshed tool list after the server sends
   * `notifications/tools/list_changed`. Callers should use this to update any
   * cached tool registrations.
   * @param tools - Updated list of bridged tools.
   */
  readonly onToolsChanged?: (tools: McpBridgedTool[]) => void;
  /**
   * Optional Makaio bus that receives MCP-backed `tool.list` and `tool.execute` handlers.
   *
   * When provided, the bridge exposes the connected MCP server's tools through
   * the standard ToolSubjects contract while preserving the local handle API.
   */
  readonly bus?: IMakaioBus;
  /**
   * Toolset name used for bus-visible MCP tools.
   *
   * Defaults to {@link extensionName}, matching detached extension identity.
   */
  readonly toolsetName?: string;
  /**
   * Priority for bridge-owned bus handlers.
   *
   * Defaults above the regular tool registry so the bridge can merge `tool.list`
   * results and route only the MCP tools it owns before delegating.
   */
  readonly busHandlerPriority?: number;
}

/** Bus handler priority used when no explicit bridge priority is configured. */
const DEFAULT_BUS_HANDLER_PRIORITY = 100;

type RegistryChangeReason = 'toolset-registered' | 'toolset-unregistered' | 'plugin-loaded';

/**
 * Map a raw MCP SDK tool list entry to the bridge-internal {@link McpBridgedTool} shape.
 * @param tool - Raw tool entry from `client.listTools()`.
 * @returns Bridged tool descriptor.
 */
function toBridgedTool(tool: { name: string; description?: string; inputSchema: unknown }): McpBridgedTool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
  };
}

/**
 * Normalize an MCP input schema into the record shape required by ToolSubjects.list.
 * @param value - Raw MCP input schema.
 * @returns Record-shaped JSON schema, or undefined when the server returned a non-object value.
 */
function toInputSchemaRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

/**
 * Convert bridge-local tool descriptors to Makaio tool-list entries.
 * @param tools - Current MCP tool descriptors.
 * @param toolsetName - Bus-visible toolset name.
 * @returns ToolInfo entries for ToolSubjects.list.
 */
function toToolInfos(tools: readonly McpBridgedTool[], toolsetName: string): ToolInfo[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    toolsetName,
    inputSchema: toInputSchemaRecord(tool.inputSchema),
  }));
}

/**
 * Convert an MCP call result to the Makaio tool-result contract.
 * @param result - Raw MCP call result.
 * @returns ToolSubjects.execute-compatible result.
 */
function toToolResult(result: McpCallToolResult): ToolResult<unknown> {
  if (result.isError === true) {
    return toolError(ToolErrorCodes.EXECUTION_ERROR, 'MCP tool returned an error result', result);
  }
  return toolSuccess(result);
}

/**
 * Convert Makaio tool input into an MCP `tools/call` argument object.
 * @param input - Tool input from `ToolSubjects.execute`.
 * @returns Record-shaped MCP arguments.
 */
function toMcpArguments(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return Object.fromEntries(Object.entries(input));
  }
  return {};
}

/**
 * Register bus handlers that expose the connected MCP server as a Makaio toolset.
 * @param options - Handler dependencies and runtime state accessors.
 * @returns Cleanup callbacks for the registered handlers.
 */
function registerMcpToolBusHandlers(options: {
  readonly bus: IMakaioBus;
  readonly client: Client;
  readonly extensionName: string;
  readonly toolsetName: string;
  readonly priority: number;
  readonly getTools: () => readonly McpBridgedTool[];
}): Array<() => void> {
  const { bus, client, extensionName, toolsetName, priority, getTools } = options;

  return [
    bus.on(
      ToolSubjects.list,
      async (context) => {
        await context.next();
        const downstream = context.result;
        const currentTools = getTools();
        const ownTools = toToolInfos(currentTools, toolsetName);
        const includeOwnToolset =
          context.payload.toolsetName === undefined || context.payload.toolsetName === toolsetName;

        context.setResult({
          tools: [...((downstream?.tools ?? []) as ToolInfo[]), ...(includeOwnToolset ? ownTools : [])],
          toolsets: [
            ...(downstream?.toolsets ?? []),
            ...(includeOwnToolset
              ? [
                  {
                    name: toolsetName,
                    description: `MCP tools exposed by ${extensionName}`,
                    version: '1.0.0',
                    toolCount: currentTools.length,
                  },
                ]
              : []),
          ],
        });
      },
      { priority },
    ),
    bus.on(
      ToolSubjects.execute,
      async (context) => {
        const tool = getTools().find((entry) => entry.name === context.payload.toolName);
        if (!tool) {
          await context.next();
          return;
        }

        try {
          const result = await client.callTool({
            name: tool.name,
            arguments: toMcpArguments(context.payload.input),
          });
          context.setResult(toToolResult(result));
        } catch (error) {
          context.setResult(errorToToolResult(error));
        }
      },
      { priority },
    ),
  ];
}

/**
 * Build an MCP SDK client for the detached bridge.
 * @param extensionName - Extension identity used in the MCP client handshake.
 * @param shouldSubscribeToToolChanges - Whether list-changed notifications should update local tools.
 * @param onToolsChanged - Handler invoked with refreshed tools from the SDK.
 * @returns Configured MCP SDK client.
 */
function createMcpBridgeClient(
  extensionName: string,
  shouldSubscribeToToolChanges: boolean,
  onToolsChanged: (tools: McpBridgedTool[]) => void,
): Client {
  return new Client(
    { name: `makaio-${extensionName}`, version: '1.0.0' },
    {
      ...(shouldSubscribeToToolChanges
        ? {
            listChanged: {
              tools: {
                autoRefresh: true,
                onChanged: (error, tools) => {
                  if (error) {
                    console.error(`[McpClientBridge:${extensionName}] Failed to refresh tools:`, error);
                    return;
                  }
                  onToolsChanged((tools ?? []).map(toBridgedTool));
                },
              },
            },
          }
        : {}),
    },
  );
}

/**
 * Emit a registryChanged event with a bridge-local monotonic revision.
 * @param bus - Optional bus to notify.
 * @param state - Mutable bridge registry state.
 * @param reason - Tool registry change reason.
 */
function emitRegistryChanged(
  bus: IMakaioBus | undefined,
  state: { revision: number; readonly extensionName: string; readonly toolsetName: string },
  reason: RegistryChangeReason,
): void {
  if (!bus) return;
  state.revision += 1;
  bus
    .emit(ToolSubjects.registryChanged, {
      revision: state.revision,
      reason,
      toolsetName: state.toolsetName,
    })
    .catch((error) => {
      console.error(`[McpClientBridge:${state.extensionName}] Failed to emit tool registry change:`, error);
    });
}

/**
 * Spawn an MCP server subprocess via stdio, connect to it as an MCP client,
 * and discover its tool list.
 *
 * The spawned subprocess communicates over its stdin/stdout using the MCP
 * JSON-RPC protocol. The SDK's {@link StdioClientTransport} manages the child
 * process lifecycle; callers must call {@link McpClientBridgeHandle.close} to
 * terminate it cleanly.
 *
 * When {@link McpClientBridgeOptions.onToolsChanged} is provided, the bridge
 * subscribes to `notifications/tools/list_changed` via the SDK's built-in
 * `listChanged.tools` handler so that tool list updates are propagated
 * automatically. The handle's {@link McpClientBridgeHandle.tools} and
 * {@link McpClientBridgeHandle.toolNames} getters reflect the latest known
 * list, updated each time the server signals a change.
 *
 * If `listTools()` fails after the transport has already connected, the bridge
 * closes the client and re-throws so no subprocess is left orphaned.
 * @param options - Bridge configuration.
 * @returns Handle exposing the live tool list and proxy methods.
 */
export async function startMcpClientBridge(options: McpClientBridgeOptions): Promise<McpClientBridgeHandle> {
  const {
    command,
    args = [],
    env,
    cwd,
    extensionName,
    onToolsChanged,
    bus,
    toolsetName = extensionName,
    busHandlerPriority = DEFAULT_BUS_HANDLER_PRIORITY,
  } = options;

  // Mutable tool list: updated at startup and on every list_changed notification.
  let currentTools: McpBridgedTool[] = [];
  const registryState = { revision: 0, extensionName, toolsetName };
  const busCleanups: Array<() => void> = [];

  /**
   * Update the internal tool list and forward the change to the caller.
   * @param tools - Refreshed tool list from the MCP server.
   */
  const handleToolsChanged = (tools: McpBridgedTool[]): void => {
    currentTools = tools;
    onToolsChanged?.(tools);
    emitRegistryChanged(bus, registryState, 'plugin-loaded');
  };

  const transport = new StdioClientTransport({
    command,
    args: [...args],
    env: env ? { ...env } : undefined,
    cwd,
  });

  const client = createMcpBridgeClient(
    extensionName,
    onToolsChanged !== undefined || bus !== undefined,
    handleToolsChanged,
  );

  await client.connect(transport);

  // Guard: if listTools() throws the subprocess is already running — close it
  // before re-throwing so no orphaned child processes are left behind.
  try {
    const toolsResult = await client.listTools();
    currentTools = (toolsResult.tools ?? []).map(toBridgedTool);
  } catch (err) {
    await client.close();
    throw err;
  }

  if (bus) {
    busCleanups.push(
      ...registerMcpToolBusHandlers({
        bus,
        client,
        extensionName,
        toolsetName,
        priority: busHandlerPriority,
        getTools: () => currentTools,
      }),
    );
    emitRegistryChanged(bus, registryState, 'toolset-registered');
  }

  let closed = false;

  return {
    get tools(): readonly McpBridgedTool[] {
      return currentTools;
    },

    get toolNames(): readonly string[] {
      return currentTools.map((t) => t.name);
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
      if (closed) throw new Error('MCP bridge is closed');
      const params: CallToolRequest['params'] = { name, arguments: args };
      return client.callTool(params);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      while (busCleanups.length > 0) {
        busCleanups.pop()?.();
      }
      emitRegistryChanged(bus, registryState, 'toolset-unregistered');
      await client.close();
    },
  };
}
