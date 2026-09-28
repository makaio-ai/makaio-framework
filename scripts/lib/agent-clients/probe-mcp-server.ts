/**
 * Minimal stdio MCP server for the manual agent-client live probe (FACT-88).
 *
 * The Claude Code probe needs one MCP tool call to observe whether PostToolUse hooks fire
 * for MCP tools. Claude Code launches this file through an `--mcp-config` entry
 * `{ command: 'bun', args: [<absolute path of this file>] }`. The server is named `probe`
 * and exposes exactly one argument-free tool, `probe_read`, which returns a fixed text.
 *
 * It implements only the JSON-RPC subset Claude Code needs (initialize,
 * notifications/initialized, tools/list, tools/call) over newline-delimited stdin/stdout,
 * so the probe carries no SDK dependency. Stdout carries protocol messages only.
 */
import { createInterface } from 'node:readline';

/** Fixed text returned by `probe_read`; the probe matches on it in transcripts. */
export const PROBE_READ_RESULT_TEXT = 'MAKAIO probe MCP read result';
/** Name of the single tool this server exposes. */
export const PROBE_TOOL_NAME = 'probe_read';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Computes the JSON-RPC response for one incoming message.
 * @param message - Parsed incoming JSON-RPC message.
 * @returns The response object, or `undefined` for notifications.
 */
export function handleProbeMessage(message: JsonRpcRequest): Record<string, unknown> | undefined {
  if (message.id === undefined) return undefined;
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.['protocolVersion'];
      return reply({
        protocolVersion: typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '1.0.0' },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: [
          {
            name: PROBE_TOOL_NAME,
            description: 'Returns a fixed probe text. Takes no arguments.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });
    case 'tools/call': {
      if (message.params?.['name'] !== PROBE_TOOL_NAME) {
        return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } };
      }
      return reply({ content: [{ type: 'text', text: PROBE_READ_RESULT_TEXT }], isError: false });
    }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  }
}

if (import.meta.main) {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
      );
      return;
    }
    const response = handleProbeMessage(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}
