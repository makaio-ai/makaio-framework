/**
 * Minimal MCP server fixture for mcp-client-bridge integration tests.
 *
 * Spawned as a subprocess via tsx. Exposes an `echo` tool and — after a short
 * self-contained delay — emits `notifications/tools/list_changed` then adds an
 * `add` tool to the list. This makes tool-list-change tests self-contained
 * without requiring external signal delivery.
 *
 * Environment variables:
 * - `MCP_FIXTURE_DELAY_MS` — ms before sending the tool-list-changed
 *   notification (default: 200). Set to a large value to suppress the
 *   notification in tests that do not need it.
 *
 * Communication:
 * - stdin/stdout: MCP JSON-RPC (stdio transport)
 * - stderr: diagnostic messages only
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const DELAY_MS = Number(process.env['MCP_FIXTURE_DELAY_MS'] ?? 200);

/** Whether the extended tool list has been unlocked. */
let extended = false;

const server = new Server(
  { name: 'test-mcp-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the input message',
      inputSchema: {
        type: 'object' as const,
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
    ...(extended
      ? [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object' as const,
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
              required: ['a', 'b'],
            },
          },
        ]
      : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};

  if (name === 'echo') {
    const message = args['message'] ?? '';
    return {
      content: [{ type: 'text' as const, text: String(message) }],
    };
  }

  if (name === 'add') {
    const a = Number(args['a'] ?? 0);
    const b = Number(args['b'] ?? 0);
    return {
      content: [{ type: 'text' as const, text: String(a + b) }],
    };
  }

  return {
    content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// After DELAY_MS, extend the tool list and notify connected clients.
// This runs after the transport is connected so clients that complete their
// initial handshake within DELAY_MS will receive the notification.
if (DELAY_MS < 60_000) {
  setTimeout(() => {
    extended = true;
    void server.sendToolListChanged().catch((error: unknown) => {
      process.stderr.write(`[fixture] sendToolListChanged failed: ${String(error)}\n`);
    });
  }, DELAY_MS);
}
