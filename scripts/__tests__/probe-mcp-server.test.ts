import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';

const SERVER_PATH = join(import.meta.dirname, '..', 'lib', 'agent-clients', 'probe-mcp-server.ts');

/**
 * Sends newline-delimited JSON-RPC messages to a fresh server and collects the responses.
 * @param messages - Messages to write to the server's stdin.
 * @param expectedResponses - Number of response lines to wait for.
 * @returns Parsed response objects in arrival order.
 */
async function exchange(
  messages: readonly Record<string, unknown>[],
  expectedResponses: number,
): Promise<Record<string, unknown>[]> {
  const child = spawn('bun', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'inherit'] });
  const responses: Record<string, unknown>[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      createInterface({ input: child.stdout }).on('line', (line) => {
        responses.push(JSON.parse(line) as Record<string, unknown>);
        if (responses.length === expectedResponses) resolve();
      });
      for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  } finally {
    child.kill();
  }
  return responses;
}

describe('probe MCP server', () => {
  it('serves initialize, tools/list and tools/call for probe_read over stdio', async () => {
    const [initialize, list, call] = await exchange(
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe_read', arguments: {} } },
      ],
      3,
    );

    expect(initialize).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'probe' }, capabilities: { tools: {} } },
    });
    expect(list).toMatchObject({
      id: 2,
      result: { tools: [{ name: 'probe_read', inputSchema: { type: 'object', properties: {} } }] },
    });
    expect((list?.['result'] as { tools: unknown[] }).tools).toHaveLength(1);
    expect(call).toMatchObject({
      id: 3,
      result: { content: [{ type: 'text', text: 'MAKAIO probe MCP read result' }] },
    });
  }, 15_000);
});
