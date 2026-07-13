import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Connect an MCP server and tear down all server-owned resources if startup fails.
 * @param server - MCP server to connect.
 * @param transport - Transport to attach to the server.
 * @param close - Idempotent teardown that owns transport-specific cleanup.
 * @param resourceName - Human-readable resource name used in startup errors.
 */
export async function connectMcpServerWithCleanup(
  server: Server,
  transport: Transport,
  close: () => Promise<void>,
  resourceName: string,
): Promise<void> {
  try {
    await server.connect(transport);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to start and clean up ${resourceName}`);
    }
    throw error;
  }
}
