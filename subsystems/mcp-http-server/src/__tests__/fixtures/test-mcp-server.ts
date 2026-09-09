/**
 * Minimal MCP server fixture for mcp-client-bridge integration tests.
 *
 * Spawned as a subprocess via tsx. Exposes an `echo` tool whose optional
 * `enableAddTool` argument adds an `add` tool and emits
 * `notifications/tools/list_changed`. Tests trigger this only after observing
 * the initial tool list, so scheduling cannot reorder the two states.
 *
 * Communication:
 * - stdin/stdout: MCP JSON-RPC (stdio transport)
 * - stderr: diagnostic messages only
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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
        properties: {
          message: { type: 'string' },
          enableAddTool: { type: 'boolean', description: 'Enable the fixture add tool and notify the client' },
        },
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
    if (args['enableAddTool'] === true) {
      extended = true;
      await server.sendToolListChanged();
    }
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
