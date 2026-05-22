import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IMcpContextRegistry } from './context-registry.js';

/** MCP tool name for the permission prompt handler. */
export const APPROVE_TOOL_NAME = 'approve';

/** Parsed arguments from Claude CLI's approve tool call. */
interface ApproveToolArgs {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
}

/** Payload forwarded to `agent.toolApprove`. */
export interface ToolApproveRequestPayload {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  agentId: string;
  adapterId: string;
  adapterName: string;
  adapterSessionId: string;
  /** Makaio session ID — required for approval routing to the owning tab. */
  sessionId: string;
}

/** Minimal response shape consumed from `agent.toolApprove`. */
export type ToolApproveResponse =
  | {
      action: 'allow';
      updatedInput?: Record<string, unknown>;
    }
  | {
      action: 'deny';
      message?: string;
    };

/** Function seam for approval RPC. */
export type RequestToolApproval = (payload: ToolApproveRequestPayload) => Promise<ToolApproveResponse>;

/**
 * Build the MCP tool definition for the approve permission-prompt tool.
 *
 * The `input` property uses `additionalProperties: true` so Claude CLI can
 * pass the tool's arbitrary argument object without schema validation failures.
 * @returns MCP tool definition object.
 */
export function buildApproveToolDefinition() {
  return {
    name: APPROVE_TOOL_NAME,
    description: 'Permission prompt handler - approves or denies tool usage requests',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input', 'tool_use_id'],
    },
  };
}

/**
 * Parse and validate arguments for the approve permission-prompt tool.
 * @param raw - Raw arguments object from the MCP call.
 * @returns Typed args on success, or a string error message on failure.
 */
function parseApproveArgs(raw: unknown): ApproveToolArgs | string {
  if (raw === null || typeof raw !== 'object') return 'Arguments must be an object';
  const obj = raw as Record<string, unknown>;
  if (typeof obj['tool_name'] !== 'string') return 'tool_name must be a string';
  if (typeof obj['tool_use_id'] !== 'string') return 'tool_use_id must be a string';
  if (typeof obj['input'] !== 'object' || obj['input'] === null || Array.isArray(obj['input'])) {
    return 'input must be an object';
  }
  return {
    tool_name: obj['tool_name'],
    tool_use_id: obj['tool_use_id'],
    input: obj['input'] as Record<string, unknown>,
  };
}

/**
 * Handle the `approve` permission-prompt tool call.
 *
 * Resolves agent context from the registry, calls `agent.toolApprove`
 * on the global bus, and maps the response to Claude CLI's `behavior` field.
 * @param rawArgs - Raw MCP tool call arguments.
 * @param contextRegistry - Registry for looking up agent context.
 * @param adapterSessionId - Adapter session ID extracted from the HTTP request header.
 * @param requestToolApproval - Approval request callback bound to the server bus.
 * @returns MCP call result with serialized `{ behavior }` JSON.
 */
export async function handleApproveToolCall(
  rawArgs: unknown,
  contextRegistry: IMcpContextRegistry,
  adapterSessionId: string | undefined,
  requestToolApproval: RequestToolApproval,
): Promise<CallToolResult> {
  const deny = (message: string): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message }) }],
  });

  const context = adapterSessionId ? contextRegistry.get(adapterSessionId) : undefined;
  if (!context) return deny('No agent context found for this session');

  const parsed = parseApproveArgs(rawArgs ?? {});
  if (typeof parsed === 'string') return deny(`Invalid approve tool arguments: ${parsed}`);

  let response: ToolApproveResponse;
  try {
    response = await requestToolApproval({
      toolName: parsed.tool_name,
      args: parsed.input,
      toolCallId: parsed.tool_use_id,
      agentId: context.agentId,
      adapterId: context.adapterId,
      adapterName: context.adapterName,
      adapterSessionId: context.adapterSessionId,
      sessionId: context.sessionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return deny(`Tool approval request failed: ${message}`);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          response.action === 'allow'
            ? { behavior: 'allow', updatedInput: response.updatedInput ?? parsed.input }
            : { behavior: 'deny', message: response.message ?? 'Denied by policy' },
        ),
      },
    ],
  };
}
