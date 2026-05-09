/**
 * Tool Handling for GitHub Copilot SDK Adapter
 *
 * Centralizes tool approval transformation, bus registration, and registry
 * tool conversion for both production (agent.ts) and test (createTestConfig)
 * use cases.
 *
 * Note: Copilot SDK's scoped can_use_tool payload now uses the shared
 * ScopedToolApprovalSchema, so these transforms align with the other adapters
 * while preserving the SDK-facing response shape.
 *
 * Pattern:
 * - toGlobalToolApproval: SDK can_use_tool → AgentToolApproveRequest (identity)
 * - fromGlobalToolApproval: AgentToolApproveResponse → SDK response (identity)
 * - registerToolApprovalHandler: Wire bus handler for scoped → global routing
 * - toCopilotToolFormat: ToolListItem\[\] → SDK Tool\[\] with bus-bridged handlers
 * - fetchToolsForCopilot: Load from registry + convert in one call
 */

import { MakaioBus } from '@makaio/bus-core';
import {
  type ToolListItem,
  ToolSubjects,
  AgentSubjects,
  type AgentToolApproveRequest,
  type AgentToolApproveResponse,
} from '@makaio/contracts';
import { safeStringify } from '@makaio/utils';
import { loadToolsFromRegistry, filterToolsWithSchema } from '@makaio/ai-adapters-stream-session';
import type { Tool, ToolInvocation } from '@github/copilot-sdk';
import { GitHubCopilotConnectorSubjects } from './namespaces/index.js';
import type { SdkPermissionRequest, SdkPermissionRequestResult } from './types/index.js';
import {
  createToolApprovalHandler,
  mergeScopedToolApproval,
  extractMcpCallTarget,
  isMcpCallTool,
  type ISessionToolLedger,
  type MergeScopedToolApprovalOptions,
  type ScopedToolApprovalRequest,
  type ToolApprovalContext,
} from '@makaio/ai-adapters-core';

export type { ToolApprovalContext } from '@makaio/ai-adapters-core';

/** Options for direct approval requests that bypass connector bus registration. */
export type CopilotDirectApprovalRequestOptions = MergeScopedToolApprovalOptions;

/**
 * Adapter identity context used to route bus-bridged tool handler calls.
 */
export interface CopilotToolHandlerContext {
  /** Adapter instance ID */
  adapterId: string;
  /** Adapter type name */
  adapterName: string;
  /** Agent ID for attribution */
  agentId: string;
  /** Session tool ledger for recording mcp_call invocations. */
  toolLedger?: ISessionToolLedger;
  /** Current turn number supplier for ledger bookkeeping. */
  getCurrentTurnNumber?: () => number;
}

/**
 * Transform SDK can_use_tool payload → AgentToolApproveRequest.
 *
 * Copilot uses the shared scoped approval schema, so this is identity with optional context override.
 * @param payload - SDK can_use_tool payload (sessionId may still come from context)
 * @param context - Optional context override
 * @returns Global tool approval request
 */
export function toGlobalToolApproval(
  payload: ScopedToolApprovalRequest,
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return mergeScopedToolApproval(payload, context, 'github-copilot-sdk');
}

/**
 * Transform AgentToolApproveResponse → SDK response format.
 *
 * Copilot uses AgentToolApproveSchema response directly, so this is identity.
 * @param response - Global tool approval response
 * @returns SDK-compatible response
 */
export function fromGlobalToolApproval(response: AgentToolApproveResponse): AgentToolApproveResponse {
  return response;
}

/**
 * Register tool approval handler on scoped connector.
 *
 * Wires GitHubCopilotSubjects.can_use_tool → AgentSubjects.toolApprove.
 * Used by createTestConfig (test harness). In production, agent.ts has wireToolApprovalRpc.
 */
export const registerToolApprovalHandler = createToolApprovalHandler(
  GitHubCopilotConnectorSubjects.can_use_tool,
  toGlobalToolApproval,
  fromGlobalToolApproval,
);

/**
 * Convenience: Request tool approval via MakaioBus (round-trip).
 *
 * For trusted call sites that need to call approval directly without bus.on() wiring.
 *
 * Accepts the scoped payload shape so callers may omit identity fields and rely on
 * explicit trusted fallback when context is unavailable.
 * @param payload - SDK can_use_tool payload
 * @param context - Optional context override
 * @param options - Controls whether trusted callers may reuse payload session and/or identity fields
 * @returns Core tool approval response
 */
export async function requestToolApproval(
  payload: ScopedToolApprovalRequest,
  context?: Partial<ToolApprovalContext>,
  options: CopilotDirectApprovalRequestOptions = {},
): Promise<AgentToolApproveResponse> {
  const request = mergeScopedToolApproval(payload, context ?? {}, 'github-copilot-sdk', {
    allowPayloadSessionFallback: options.allowPayloadSessionFallback ?? false,
    allowPayloadIdentityFallback: options.allowPayloadIdentityFallback ?? false,
  });
  return MakaioBus.request(AgentSubjects.toolApprove, request);
}

// --------------------------------------------------------------------------
// SDK Permission Request mapping (legacy utils consolidation)
// These map between the SDK's requestPermission callback types and core schema.
// --------------------------------------------------------------------------

/**
 * Map Copilot SDK PermissionRequest to core ToolApprovalRequest.
 *
 * SDK's requestPermission callback receives PermissionRequest and returns PermissionRequestResult.
 * This function normalizes SDK types to core schema.
 * @param request - SDK permission request from requestPermission callback
 * @returns Core tool approval request
 */
export function mapPermissionRequestToCoreRequest(
  request: SdkPermissionRequest,
): Omit<ScopedToolApprovalRequest, 'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId' | 'sessionId'> {
  if (request.kind === 'mcp') {
    return {
      toolName: `${request.serverName}.${request.toolName}`,
      args: getMcpRequestArgs(request),
      toolCallId: `${request.serverName}_${request.toolName}_${Date.now()}`,
    };
  }

  const args: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'shell':
        return { command: request.fullCommandText, intention: request.intention };
      case 'write':
        return { fileName: request.fileName, diff: request.diff, intention: request.intention };
      case 'read':
        return { path: request.path, intention: request.intention };
      default:
        return {};
    }
  })();

  // Handle different permission request kinds
  return {
    toolName: request.kind === 'shell' ? 'bash' : request.kind,
    args,
    toolCallId: `${request.kind}_${Date.now()}`,
  };
}

/**
 * Narrow an MCP permission request to one that carries object args.
 * @param request - SDK permission request to inspect
 * @returns Whether the MCP request exposes object-shaped args
 */
function isMcpRequestWithArgs(
  request: SdkPermissionRequest,
): request is SdkPermissionRequest & { kind: 'mcp'; args: Record<string, unknown> } {
  return request.kind === 'mcp' && 'args' in request && !!request.args && typeof request.args === 'object';
}

/**
 * Read MCP request args while tolerating the SDK's incomplete exported type.
 * @param request - SDK permission request for an MCP tool invocation
 * @returns Object args when present, otherwise an empty object
 */
function getMcpRequestArgs(request: SdkPermissionRequest): Record<string, unknown> {
  return isMcpRequestWithArgs(request) ? request.args : {};
}

/**
 * Map core ToolApprovalResponse to Copilot SDK PermissionRequestResult.
 * @param response - Core tool approval response
 * @returns SDK permission request result for requestPermission callback
 */
export function mapCoreResponseToPermissionResult(response: AgentToolApproveResponse): SdkPermissionRequestResult {
  if (response.action === 'allow') {
    return { kind: 'approved' };
  } else {
    return { kind: 'denied-interactively-by-user' };
  }
}

// --------------------------------------------------------------------------
// Registry Tool Integration
// Converts Makaio ToolListItem[] to Copilot SDK Tool[] with bus-bridged handlers.
// --------------------------------------------------------------------------

/**
 * Execute a registry tool via the bus and return a serialised result string.
 *
 * Emits `ToolSubjects.completed` on success or `ToolSubjects.error` on failure.
 * Never throws — all errors are returned as JSON-encoded error objects so the
 * Copilot SDK always receives a string.
 *
 * Records an mcp_call ledger entry when the tool is the `mcp_call` meta-tool
 * and a tool ledger is present in the context.
 * @param tool - The registry tool to execute
 * @param execArgs - Approved (possibly updated) arguments
 * @param invocation - Live SDK invocation for session routing
 * @param context - Adapter identity for bus routing (includes optional ledger)
 * @param startedAt - Timestamp from the caller's ToolSubjects.started emission, used for durationMs
 * @returns Serialised tool result
 */
async function executeCopilotTool(
  tool: ToolListItem & { inputSchema: Record<string, unknown> },
  execArgs: Record<string, unknown>,
  invocation: ToolInvocation,
  context: CopilotToolHandlerContext,
  startedAt: number,
): Promise<string> {
  const executionId = invocation.toolCallId;
  const toolsetName = tool.toolsetName;
  // ToolSubjects.started is already emitted by the handler in toCopilotToolFormat
  // before approval — this helper only runs post-approval, so no duplicate emission.
  try {
    const result = await MakaioBus.request(ToolSubjects.execute, {
      toolName: tool.name,
      input: execArgs,
      adapterId: context.adapterId,
      adapterName: context.adapterName,
      contextOverrides: {
        sessionId: invocation.sessionId,
        agentId: context.agentId,
        toolCallId: invocation.toolCallId,
      },
    });
    if (!result.success) {
      void MakaioBus.emit(ToolSubjects.error, {
        toolName: tool.name,
        toolsetName,
        executionId,
        timestamp: Date.now(),
        error: { code: result.error.code, message: result.error.message },
      });
      return JSON.stringify({ error: result.error.message, code: result.error.code });
    }
    const output = typeof result.data === 'string' ? result.data : safeStringify(result.data ?? null);
    void MakaioBus.emit(ToolSubjects.completed, {
      toolName: tool.name,
      toolsetName,
      executionId,
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
    });

    if (context.toolLedger && isMcpCallTool(tool.name)) {
      const targetTool = extractMcpCallTarget(execArgs);
      if (targetTool !== undefined) {
        const turnNumber = context.getCurrentTurnNumber?.();
        if (turnNumber !== undefined && turnNumber > 0) {
          context.toolLedger.recordCall(targetTool, turnNumber);
        }
      }
    }

    return output;
  } catch (error) {
    void MakaioBus.emit(ToolSubjects.error, {
      toolName: tool.name,
      toolsetName,
      executionId,
      timestamp: Date.now(),
      error: { code: 'EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error) },
    });
    return JSON.stringify({ error: String(error) });
  }
}

/**
 * Convert registry ToolListItem[] to Copilot SDK Tool[] with bus-bridged handlers.
 *
 * Each tool's handler executes via ToolSubjects.execute on the bus, bridging
 * the SDK's handler interface to Makaio's async bus execution. The handler
 * uses the live invocation.sessionId so session routing is always current,
 * even when the connector session ID is resolved lazily.
 *
 * Handlers always return a result string and never throw, satisfying the
 * SDK contract that every tool invocation produces a deterministic output.
 * @param tools - Tools from loadToolsFromRegistry (may have undefined inputSchema)
 * @param context - Adapter identity for bus routing and attribution
 * @returns Copilot SDK Tool[] with embedded execution handlers
 */
export function toCopilotToolFormat(
  tools: ToolListItem[],
  context: CopilotToolHandlerContext,
): Tool<Record<string, unknown>>[] {
  return filterToolsWithSchema(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    handler: async (args: Record<string, unknown>, invocation: ToolInvocation): Promise<string> => {
      // Gate execution behind approval — SDK's onPermissionRequest does not fire for
      // custom tools registered via SessionConfig.tools, so we must approve here.
      // Both fallback flags are enabled explicitly: the payload carries full identity
      // (adapterId, agentId, etc.) from the handler closure and sessionId from the
      // live invocation, so reusing them is safe here.
      const executionId = invocation.toolCallId;
      const toolsetName = tool.toolsetName;
      const startedAt = Date.now();
      void MakaioBus.emit(ToolSubjects.started, {
        toolName: tool.name,
        toolsetName,
        executionId,
        timestamp: startedAt,
      });

      let approvalResponse: Awaited<ReturnType<typeof requestToolApproval>>;
      try {
        approvalResponse = await requestToolApproval(
          {
            toolName: tool.name,
            args: args ?? {},
            toolCallId: invocation.toolCallId,
            adapterId: context.adapterId,
            adapterName: context.adapterName,
            agentId: context.agentId,
            adapterSessionId: invocation.sessionId,
            sessionId: invocation.sessionId,
          },
          undefined,
          { allowPayloadSessionFallback: true, allowPayloadIdentityFallback: true },
        );
      } catch (approvalError) {
        // Treat bus/handler failures as a soft denial — do not propagate to the SDK.
        void MakaioBus.emit(ToolSubjects.error, {
          toolName: tool.name,
          toolsetName,
          executionId,
          timestamp: Date.now(),
          error: {
            code: 'APPROVAL_ERROR',
            message: approvalError instanceof Error ? approvalError.message : String(approvalError),
          },
        });
        return JSON.stringify({
          error: approvalError instanceof Error ? approvalError.message : String(approvalError),
        });
      }
      if (approvalResponse.action === 'deny') {
        const message = approvalResponse.message ?? 'Tool execution was denied.';
        if (approvalResponse.shouldAbort) {
          void MakaioBus.emit(ToolSubjects.error, {
            toolName: tool.name,
            toolsetName,
            executionId,
            timestamp: Date.now(),
            error: { code: 'APPROVAL_DENIED_ABORT', message },
          });
          return JSON.stringify({ error: message, shouldAbort: true });
        }
        void MakaioBus.emit(ToolSubjects.error, {
          toolName: tool.name,
          toolsetName,
          executionId,
          timestamp: Date.now(),
          error: { code: 'APPROVAL_DENIED', message },
        });
        return JSON.stringify({ error: message });
      }
      // Use modified args if the approver updated them (e.g., user corrected a path).
      const execArgs = approvalResponse.updatedInput ?? args ?? {};
      return executeCopilotTool(tool, execArgs, invocation, context, startedAt);
    },
  }));
}

/**
 * Load tools from the registry and convert to Copilot SDK format in one call.
 *
 * Wraps loadToolsFromRegistry (which never throws) and toCopilotToolFormat.
 * Returns an empty array when no tools are registered or the registry is unavailable.
 * @param context - Adapter identity for registry filtering and handler routing
 * @returns Copilot SDK Tool[] ready for inclusion in SessionConfig.tools
 */
export async function fetchToolsForCopilot(
  context: CopilotToolHandlerContext,
): Promise<Tool<Record<string, unknown>>[]> {
  const tools = await loadToolsFromRegistry(context.adapterId, context.adapterName);
  return toCopilotToolFormat(tools, context);
}
