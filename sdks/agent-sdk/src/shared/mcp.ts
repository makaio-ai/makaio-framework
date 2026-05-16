import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpResolvedServer, McpTransportConfig } from '@makaio/contracts';
import type {
  CreateSdkMcpServerOptions,
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  SdkMcpToolDefinition,
} from './types.js';

type TransportMcpServerConfig = Exclude<McpServerConfig, McpSdkServerConfigWithInstance>;

interface PreparedMcpServers {
  readonly servers: Record<string, TransportMcpServerConfig>;
  readonly close: () => Promise<void>;
}

interface SdkMcpHttpBridge {
  readonly config: Extract<McpServerConfig, { type: 'http' }>;
  readonly close: () => Promise<void>;
}

/**
 * Create an in-process MCP server configuration.
 *
 * Matches the Claude Agent SDK contract by returning a non-serializable
 * `{ type: 'sdk', name, instance }` config. Query startup converts this live
 * server instance into a temporary local HTTP MCP transport before handing the
 * session config to adapters.
 * @param options - Server configuration options.
 * @returns An McpServerConfig ready for use in query options.
 */
export const createSdkMcpServer = (options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance => {
  const server = new McpServer(
    { name: options.name, version: options.version ?? '1.0.0' },
    { capabilities: options.tools && options.tools.length > 0 ? { tools: {} } : {} },
  );

  for (const tool of options.tools ?? []) {
    registerSdkMcpTool(server, tool, options.alwaysLoad === true);
  }

  return { type: 'sdk', name: options.name, instance: server };
};

const registerSdkMcpTool = (server: McpServer, tool: SdkMcpToolDefinition, alwaysLoad: boolean): void => {
  const meta =
    alwaysLoad || tool._meta !== undefined
      ? { ...(alwaysLoad ? { 'anthropic/alwaysLoad': true } : {}), ...(tool._meta ?? {}) }
      : undefined;

  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations !== undefined && { annotations: tool.annotations }),
      ...(meta !== undefined && { _meta: meta }),
    },
    tool.handler,
  );
};

const closeHttpServerSafely = async (server: http.Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const listenForHttpPort = async (server: http.Server): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unexpected SDK MCP HTTP server address'));
        return;
      }
      resolve(address.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

const startSdkMcpHttpBridge = async (config: McpSdkServerConfigWithInstance): Promise<SdkMcpHttpBridge> => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await config.instance.connect(transport);

  const httpServer = http.createServer((req, res) => {
    void transport.handleRequest(req, res).catch((error: unknown) => {
      console.error(`[Agent SDK MCP:${config.name}] Failed to handle MCP request:`, error);
      if (!res.headersSent && !res.writableEnded) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    });
  });

  let port: number;
  try {
    port = await listenForHttpPort(httpServer);
  } catch (error) {
    await Promise.allSettled([config.instance.close(), closeHttpServerSafely(httpServer)]);
    throw error;
  }

  return {
    config: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
    close: async () => {
      httpServer.closeAllConnections();
      const results = await Promise.allSettled([config.instance.close(), closeHttpServerSafely(httpServer)]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
      if (errors.length > 0) {
        throw new AggregateError(errors, `Failed to close SDK MCP server ${config.name}`);
      }
    },
  };
};

/**
 * Start temporary local HTTP bridges for in-process SDK MCP server configs.
 * @param servers - User-provided MCP server record.
 * @returns Transport-only server configs and an aggregate cleanup callback.
 */
export const prepareMcpServersForSession = async (
  servers: Record<string, McpServerConfig>,
): Promise<PreparedMcpServers> => {
  const prepared: Record<string, TransportMcpServerConfig> = {};
  const bridges: SdkMcpHttpBridge[] = [];

  try {
    for (const [key, config] of Object.entries(servers)) {
      if (config.type === 'sdk') {
        const bridge = await startSdkMcpHttpBridge(config);
        bridges.push(bridge);
        prepared[key] = bridge.config;
      } else {
        prepared[key] = config;
      }
    }
  } catch (error) {
    await Promise.allSettled(bridges.map((bridge) => bridge.close()));
    throw error;
  }

  return {
    servers: prepared,
    close: async () => {
      const results = await Promise.allSettled(bridges.map((bridge) => bridge.close()));
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => (result.reason instanceof Error ? result.reason : new Error(String(result.reason))));
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to close SDK MCP server bridges');
      }
    },
  };
};

/**
 * Convert a single Claude SDK-style `McpServerConfig` entry to a Makaio
 * `McpTransportConfig`.
 *
 * The two types are structurally equivalent. The only difference is that the
 * SDK's stdio variant treats `type` as optional (defaulting to `'stdio'`),
 * whereas `McpTransportConfig` requires the discriminant on every branch.
 * @param config - Claude SDK server configuration.
 * @returns Makaio transport configuration with an explicit `type` discriminant.
 */
const toTransportConfig = (config: TransportMcpServerConfig): McpTransportConfig => {
  if (config.type === 'sse') {
    return {
      type: 'sse',
      url: config.url,
      ...(config.headers !== undefined && { headers: config.headers }),
      ...(config.tools !== undefined && { tools: config.tools }),
      ...(config.alwaysLoad !== undefined && { alwaysLoad: config.alwaysLoad }),
    };
  }
  if (config.type === 'http') {
    return {
      type: 'http',
      url: config.url,
      ...(config.headers !== undefined && { headers: config.headers }),
      ...(config.tools !== undefined && { tools: config.tools }),
      ...(config.alwaysLoad !== undefined && { alwaysLoad: config.alwaysLoad }),
    };
  }
  // Default branch: stdio (type is omitted or explicitly 'stdio').
  return {
    type: 'stdio',
    command: config.command,
    ...(config.args !== undefined && { args: config.args }),
    ...(config.env !== undefined && { env: config.env }),
    ...(config.alwaysLoad !== undefined && { alwaysLoad: config.alwaysLoad }),
  };
};

/**
 * Build a `McpResolvedServer` array from a Claude Agent SDK-style `mcpServers`
 * config record.
 *
 * Each entry in the record maps a server name to a transport configuration.
 * The resulting `McpResolvedServer` objects use `'direct'` exposure mode so
 * all tools from these servers are immediately available to the agent without
 * requiring a discovery step.
 *
 * This is the inverse of `buildMcpServersRecord` in the claude-agent-sdk
 * adapter, which converts `McpResolvedServer[]` → SDK `McpServerConfig`.
 * @param servers - Record of server name to Claude SDK server configuration.
 * @returns Array of Makaio resolved servers ready for adapter consumption.
 */
export const buildMcpSessionContext = (servers: Record<string, TransportMcpServerConfig>): McpResolvedServer[] =>
  Object.entries(servers).map(([name, config]) => ({
    name,
    transport: toTransportConfig(config),
    exposureMode: 'direct' as const,
  }));
