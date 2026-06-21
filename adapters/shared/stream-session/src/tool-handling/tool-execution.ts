/**
 * Shared tool execution utility.
 *
 * Pure function for executing a tool via the MakaioBus ToolRegistry RPC,
 * emitting lifecycle events before and after execution. This implementation
 * is extracted from the Anthropic SDK adapter which handles bus errors more
 * carefully (try/catch with error event emission).
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { type ToolExecuteResult, ToolSubjects } from '@makaio/contracts';
import type { ToolStartedEvent, ToolCompletedEvent } from '@makaio/ai-adapters-core';

import type { ToolCall } from '../namespaces/schemas/tool-calls.js';
import type { ToolExecutionContextOverrides } from './tool-result.js';

/**
 * Minimal SDK event emitter interface for tool lifecycle events.
 *
 * Both adapter SdkEventMessage discriminated unions include ToolStartedEvent
 * and ToolCompletedEvent. Using a structural union here avoids the shared
 * package depending on adapter-specific namespaces.
 */
export type ToolLifecycleEmitter = (event: ToolStartedEvent | ToolCompletedEvent) => Promise<void>;

/**
 * Execute a tool via Bus RPC.
 *
 * Routes tool execution through the ToolRegistry via MakaioBus.
 * Emits tool_started before execution and tool_completed after (on both
 * success and failure paths). On bus error the error is re-thrown after
 * the tool_completed failure event is emitted.
 * @param bus - Bus that owns the ToolRegistry handlers
 * @param toolCall - The normalized tool call to execute
 * @param emitSdkEvent - Callback to emit SDK lifecycle events
 * @param contextOverrides - Execution context (cwd, env, sessionId, agentId, turnId)
 * @returns Tool execution result
 */
export async function executeTool(
  bus: IMakaioBus,
  toolCall: ToolCall,
  emitSdkEvent: ToolLifecycleEmitter,
  contextOverrides: ToolExecutionContextOverrides,
): Promise<ToolExecuteResult> {
  await emitSdkEvent({
    eventType: 'tool_started',
    toolName: toolCall.function.name,
    toolCallId: toolCall.id,
  });

  try {
    // Parse arguments from JSON string (assembled by stream-bridge from delta fragments)
    const input: unknown = JSON.parse(toolCall.function.arguments);

    // Execute tool via bus RPC (cross-namespace request via global MakaioBus).
    // Inject toolCallId so tools can access the originating tool call ID.
    const result = await bus.request(ToolSubjects.execute, {
      toolName: toolCall.function.name,
      input,
      adapterId: contextOverrides.adapterId,
      adapterName: contextOverrides.adapterName,
      contextOverrides: { ...contextOverrides, toolCallId: toolCall.id },
    });

    return emitSdkEvent({
      eventType: 'tool_completed',
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      result: result.success ? JSON.stringify(result.data) : JSON.stringify(result.error),
      success: result.success,
    }).then(() => result);
  } catch (error) {
    const errorPayload =
      error instanceof Error
        ? { message: error.message, name: error.name }
        : { message: String(error), name: 'UnknownError' };

    await emitSdkEvent({
      eventType: 'tool_completed',
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      result: JSON.stringify(errorPayload),
      success: false,
    });
    throw error;
  }
}
