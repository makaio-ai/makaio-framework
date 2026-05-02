import type { McpServer, EnvVariable, HttpHeader } from '@agentclientprotocol/sdk';
import type { McpResolvedServer } from '@makaio/contracts';

/**
 * Convert a `Record<string, string>` env map to the ACP `EnvVariable[]` format.
 * @param env - Environment variables as a key-value record
 * @returns ACP-compatible environment variable array
 */
function toEnvVariables(env: Record<string, string> | undefined): EnvVariable[] {
  if (!env) return [];
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

/**
 * Convert a `Record<string, string>` headers map to the ACP `HttpHeader[]` format.
 * @param headers - HTTP headers as a key-value record
 * @returns ACP-compatible HTTP header array
 */
function toHttpHeaders(headers: Record<string, string> | undefined): HttpHeader[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/**
 * Convert a Makaio `McpResolvedServer` to the ACP `McpServer` shape.
 *
 * The two types share the same transport semantics but differ structurally:
 * - ACP uses `{ name, value }` arrays for env/headers; Makaio uses `Record<string, string>`
 * - ACP stdio omits the `type` discriminant; HTTP/SSE require it
 * - ACP arrays are required (not optional); empty arrays for absent fields
 * @param server - Resolved server from the Makaio MCP session context
 * @returns ACP-compatible server configuration
 */
function toAcpServer(server: McpResolvedServer): McpServer {
  const { transport } = server;

  if (transport.type === 'stdio') {
    return {
      name: server.name,
      command: transport.command,
      args: transport.args ?? [],
      env: toEnvVariables(transport.env),
    };
  }

  if (transport.type === 'sse') {
    return {
      type: 'sse',
      name: server.name,
      url: transport.url,
      headers: toHttpHeaders(transport.headers),
    };
  }

  if (transport.type === 'http') {
    return {
      type: 'http',
      name: server.name,
      url: transport.url,
      headers: toHttpHeaders(transport.headers),
    };
  }

  // Exhaustive check — compile error if a new transport type is added without handling.
  const _exhaustive: never = transport;
  throw new Error(`Unknown MCP transport type: ${(_exhaustive as { type: string }).type}`);
}

/**
 * Convert an array of Makaio resolved servers to ACP `McpServer[]`.
 * Returns an empty array when no servers are provided.
 * @param servers - Resolved MCP servers from the session context
 * @returns ACP-compatible server array for `newSession()`
 */
export function toAcpMcpServers(servers: McpResolvedServer[] | undefined): McpServer[] {
  if (!servers || servers.length === 0) return [];
  return servers.map(toAcpServer);
}
