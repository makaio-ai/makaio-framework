/** Shared test helpers for the mcp-http-server integration tests. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IMakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';

/**
 * Create an MCP client connected to the given port.
 * @param port - HTTP port to connect to.
 * @param adapterSessionId - Optional adapter session ID passed as a query param.
 * @returns Connected client and transport.
 */
export async function createClient(
  port: number,
  adapterSessionId?: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const url = adapterSessionId
    ? new URL(`http://127.0.0.1:${port}/?adapterSessionId=${encodeURIComponent(adapterSessionId)}`)
    : new URL(`http://127.0.0.1:${port}/`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

/**
 * Register a one-shot ToolSubjects.list handler returning an empty tool list.
 * @param bus - Bus instance to register on.
 * @returns Cleanup function that removes the handler.
 */
export function registerEmptyToolList(bus: IMakaioBus): () => void {
  return bus.on(ToolSubjects.list, (ctx) => {
    ctx.setResult({ tools: [], toolsets: [] });
  });
}
