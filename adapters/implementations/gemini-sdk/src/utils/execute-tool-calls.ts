import {
  CoreToolCallStatus,
  type Config,
  type GeminiChat,
  type SuccessfulToolCall,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
} from '@google/gemini-cli-core';
import { GeminiConnectorSubjects, type SdkEvent } from '../namespaces/index.js';
import type { GeminiConnector } from '../connector.js';
import { MakaioBus, NoHandlerError, RequestError } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import { extractMcpCallTarget, isMcpCallTool, type ISessionToolLedger } from '@makaio/ai-adapters-core';

/** Bound tool-approval callback forwarded from the connector to the session and execute-tool-calls. */
export type ToolApprovalFn = GeminiConnector['requestToolApproval'];

/** Bound error handler forwarded from the connector to the session and execute-tool-calls. */
export type HandleErrorFn = GeminiConnector['handleError'];

export type ExecuteToolCallsOptions = {
  turnAbortController?: AbortController;
  geminiChat: GeminiChat;
  geminiConfig: Config;
  emitSdkEvent: (event: SdkEvent) => Promise<void>;
  requestToolApproval: ToolApprovalFn;
  handleError: HandleErrorFn;
  adapterId?: string;
  adapterName?: string;
  /** Agent ID forwarded to the bus execution path for attribution. */
  agentId?: string;
  /** Session ID forwarded to the bus execution path for context correlation. */
  sessionId?: string;
  turnId?: string;
  /** LLM reasoning/thinking accumulated before these tool calls (when available) */
  reasoning?: string;
  /**
   * Names of tools loaded from the central ToolRegistry.
   * When the SDK's internal ToolRegistry does not contain a tool name from this set,
   * execution falls back to MakaioBus.request(ToolSubjects.execute, ...).
   */
  registryToolNames?: ReadonlySet<string>;
  /** Session tool ledger for recording mcp_call usage. */
  toolLedger?: ISessionToolLedger;
  /** Current turn number supplier for ledger bookkeeping. */
  getCurrentTurnNumber?: () => number;
};

type GeminiPart = ToolCallResponseInfo['responseParts'][number];

/**
 * Serialize a value to JSON, preserving structure for BigInt and circular
 * references instead of collapsing to `[object Object]`.
 * @param value - The value to serialize
 * @returns JSON string, or a fallback string on failure
 */
function safeStringify(value: unknown): string {
  if (value === undefined) return 'null';
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/* eslint-disable max-lines-per-function, complexity */
/**
 * Execute tool calls with Makaio bus approval (bypasses MessageBus complexity).
 * Requests approval first, then executes approved tools directly via registry.
 * @param toolCalls - Array of tool calls to execute
 * @param options - Configuration options for tool execution
 * @returns Promise containing response parts for tool call results
 */
export async function executeToolCalls(
  toolCalls: ToolCallRequestInfo[],
  options: ExecuteToolCallsOptions,
): Promise<{ responseParts: GeminiPart[] }> {
  const {
    turnAbortController,
    geminiConfig,
    geminiChat,
    emitSdkEvent,
    requestToolApproval,
    handleError,
    reasoning,
    registryToolNames,
    sessionId,
    agentId,
    adapterId,
    adapterName,
    toolLedger,
    getCurrentTurnNumber,
  } = options;
  const responseParts: GeminiPart[] = [];
  if (!toolCalls.length) return { responseParts };

  const completedToolCalls: SuccessfulToolCall[] = [];
  const abortSignal = turnAbortController?.signal ?? new AbortController().signal;
  const toolRegistry = geminiConfig.getToolRegistry();

  for (const toolCall of toolCalls) {
    if (abortSignal.aborted) break;

    try {
      // Emit to catch-all sdk.event with discriminated type
      await emitSdkEvent({
        type: 'agent.tool.started',
        toolCallId: toolCall.callId,
        title: toolCall.name,
        kind: 'execute',
        status: 'pending',
        rawInput: toolCall.args,
      });

      // Request approval via SDK-level subject BEFORE execution
      let approval;
      try {
        approval = await requestToolApproval(GeminiConnectorSubjects.acp.tool_approval, {
          callId: toolCall.callId,
          name: toolCall.name,
          args: toolCall.args,
          isClientInitiated: toolCall.isClientInitiated,
          prompt_id: toolCall.prompt_id,
          reasoning,
        });
      } catch (error) {
        // Handle NoHandlerError gracefully - don't terminate, let agent try alternatives
        if (error instanceof RequestError || error instanceof NoHandlerError) {
          const wrappedError = new Error(
            "Tool approval request failed, make sure that there's a handler registered: " +
              (error instanceof Error ? error.message : String(error)),
          );
          handleError(wrappedError, false);
          // Return error response to LLM so it can try an alternative approach
          responseParts.push({
            functionResponse: {
              id: toolCall.callId,
              name: toolCall.name,
              response: { error: wrappedError.message },
            },
          });
          continue;
        }
        throw error;
      }

      // Handle denial
      if (approval.action !== 'allow') {
        if (approval.shouldAbort) {
          turnAbortController?.abort();
          queueMicrotask(() => {
            handleError(new Error(`Tool use denied by approval handler: ${approval.message}`), false);
          });
          break;
        }

        // Soft denial - return error response
        const denialMessage = approval.message ?? 'Tool execution denied by approval handler.';
        responseParts.push({
          functionResponse: {
            id: toolCall.callId,
            name: toolCall.name,
            response: { error: denialMessage },
          },
        });
        // Emit to catch-all sdk.event with discriminated type
        await emitSdkEvent({
          type: 'agent.tool.updated',
          toolCallId: toolCall.callId,
          status: 'failed',
        });
        continue;
      }

      // Get approved args (may be modified by approval handler)
      const approvedArgs = (approval.updatedInput as Record<string, unknown>) ?? toolCall.args;

      // Gemini sometimes prefixes tool names with "default_api." - strip it for lookup
      const normalizedToolName = toolCall.name.replace(/^default_api\./, '');
      const nativeTool = toolRegistry.getTool(normalizedToolName);

      let toolResponse: { output: string };
      let functionResponsePart: GeminiPart;

      if (nativeTool) {
        // Native path: execute directly via SDK ToolRegistry
        // Build outside try so invocation is accessible for completedToolCalls tracking,
        // but wrap both build and execute to guarantee terminal lifecycle events.
        let invocation: ReturnType<typeof nativeTool.build>;
        let toolResult;
        try {
          invocation = nativeTool.build(approvedArgs);
          toolResult = await invocation.execute({ abortSignal });
        } catch (execError) {
          // Emit terminal failure event before propagating so downstream consumers
          // always see a paired agent.tool.updated after agent.tool.started.
          // Covers both build-time validation errors and runtime execution failures.
          await emitSdkEvent({
            type: 'agent.tool.updated',
            toolCallId: toolCall.callId,
            status: 'failed',
          });
          throw execError;
        }

        // Convert llmContent to the { output: string } shape Gemini expects
        const llmContent = toolResult.llmContent;
        toolResponse =
          typeof llmContent === 'string' ? { output: llmContent } : { output: safeStringify(llmContent ?? null) };

        functionResponsePart = {
          functionResponse: {
            id: toolCall.callId,
            name: toolCall.name,
            response: toolResponse,
          },
        };

        responseParts.push(functionResponsePart);

        // Emit to catch-all sdk.event with discriminated type (including tool output)
        await emitSdkEvent({
          type: 'agent.tool.updated',
          toolCallId: toolCall.callId,
          status: 'completed',
          output: toolResponse,
        });

        // Track completed call for SDK history (native tools only — registry tools are not
        // in the SDK's internal ToolRegistry so recordCompletedToolCalls cannot use them)
        const completedRequest = { ...toolCall, args: approvedArgs };
        const completedResponse: ToolCallResponseInfo = {
          callId: toolCall.callId,
          responseParts: [functionResponsePart],
          resultDisplay: toolResult.returnDisplay,
          error: undefined,
          errorType: undefined,
        };
        completedToolCalls.push({
          status: CoreToolCallStatus.Success,
          request: completedRequest,
          tool: nativeTool,
          response: completedResponse,
          invocation,
        });
      } else if (registryToolNames?.has(normalizedToolName)) {
        // Registry tool fallback path: execute via MakaioBus
        try {
          const result = await MakaioBus.request(ToolSubjects.execute, {
            toolName: normalizedToolName,
            input: approvedArgs,
            adapterId,
            adapterName,
            contextOverrides: {
              sessionId,
              agentId,
              toolCallId: toolCall.callId,
            },
          });

          const outputString = result.success
            ? typeof result.data === 'string'
              ? result.data
              : safeStringify(result.data ?? null)
            : safeStringify({ error: result.error.message, code: result.error.code });

          toolResponse = { output: outputString };
          functionResponsePart = {
            functionResponse: {
              id: toolCall.callId,
              name: toolCall.name,
              response: toolResponse,
            },
          };

          responseParts.push(functionResponsePart);

          // Emit to catch-all sdk.event with discriminated type
          await emitSdkEvent({
            type: 'agent.tool.updated',
            toolCallId: toolCall.callId,
            status: result.success ? 'completed' : 'failed',
            output: toolResponse,
          });

          // Only record successful mcp_call executions in the ledger.
          // Failed calls don't count toward promotion scoring — a tool that
          // consistently fails should not be promoted to direct-inject.
          if (result.success && toolLedger && isMcpCallTool(normalizedToolName)) {
            const targetTool = extractMcpCallTarget(approvedArgs);
            if (targetTool !== undefined) {
              const turnNumber = getCurrentTurnNumber?.();
              if (turnNumber !== undefined && turnNumber > 0) {
                toolLedger.recordCall(targetTool, turnNumber);
              }
            }
          }
        } catch (busError) {
          // Convert bus error (e.g. NoHandlerError) to a tool response so the LLM can recover
          const errorMessage = busError instanceof Error ? busError.message : String(busError);
          handleError(busError instanceof Error ? busError : new Error(errorMessage), false);
          const errorResponse = { output: safeStringify({ error: errorMessage }) };
          responseParts.push({
            functionResponse: {
              id: toolCall.callId,
              name: toolCall.name,
              response: errorResponse,
            },
          });
          await emitSdkEvent({
            type: 'agent.tool.updated',
            toolCallId: toolCall.callId,
            status: 'failed',
            output: errorResponse,
          });
        }
      } else {
        // Emit terminal failure event before throwing so agent.tool.started
        // is always paired with a terminal agent.tool.updated event.
        await emitSdkEvent({
          type: 'agent.tool.updated',
          toolCallId: toolCall.callId,
          status: 'failed',
        });
        throw new Error(`Tool not found: ${toolCall.name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (abortSignal.aborted) {
        break;
      }

      handleError(error instanceof Error ? error : new Error(errorMessage), true);
      throw error;
    }
  }

  if (completedToolCalls.length && geminiChat) {
    geminiChat.recordCompletedToolCalls(geminiConfig.getModel(), completedToolCalls);
  }

  return { responseParts };
}
