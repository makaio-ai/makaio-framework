/**
 * Tool Handling for Pi SDK Adapter
 *
 * Centralizes tool approval transformation, bus registration, and the
 * `beforeToolCall` hook factory for both production (agent.ts) and test
 * (createTestConfig) use cases.
 *
 * Pattern:
 * - toGlobalToolApproval: ScopedToolApprovalRequest → AgentToolApproveRequest
 * - registerToolApprovalHandler: Wire bus handler for scoped → global routing
 * - createPiBeforeToolCallHook: Return Pi-compatible beforeToolCall function
 *
 * Notes on Pi SDK's approval model:
 * - Pi's `agent.beforeToolCall` is the single hook for ALL tools (native + custom).
 * - Returning `undefined` allows execution; `{ block: true, reason }` denies it.
 * - The adapter REPLACES the default hook (which is Pi's built-in permission system)
 *   rather than chaining, because Makaio takes over tool approval entirely.
 * - `BeforeToolCallContext.toolCall` carries `id` (the toolCallId) and `name`
 *   (the tool name) per the pi-agent-core AgentToolCall shape.
 * @packageDocumentation
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from '@mariozechner/pi-agent-core';
import {
  createToolApprovalHandler,
  mergeScopedToolApproval,
  type ScopedToolApprovalRequest,
  type ToolApprovalContext,
} from '@makaio/ai-adapters-core';
import type { AgentToolApproveRequest, AgentToolApproveResponse } from '@makaio/contracts';
import { PiSdkSubjects } from './namespaces/index.js';

export type { ToolApprovalContext } from '@makaio/ai-adapters-core';

/**
 * Tool-call fields extracted from Pi's `BeforeToolCallContext`.
 *
 * This is all the hook knows about a tool call at approval time — the identity
 * fields (agentId, adapterId, etc.) come from the connector's binding closure
 * rather than from Pi's context.
 */
export interface PiToolCallPayload {
  /** Unique identifier for this tool call (from `toolCall.id`). */
  toolCallId: string;
  /** Name of the tool being called (from `toolCall.name`). */
  toolName: string;
  /** Validated tool arguments (from `args`). */
  args: Record<string, unknown>;
}

/**
 * Bound approval callback type for `createPiBeforeToolCallHook`.
 *
 * The connector creates a bound version of this callback that has adapter
 * context (agentId, adapterId, adapterSessionId, sessionId) already captured
 * in its closure. The hook provides only the tool-specific fields from Pi's
 * `BeforeToolCallContext`, keeping the hook itself free of adapter state.
 * @param payload - Tool-call fields extracted from Pi's BeforeToolCallContext
 * @returns Promise resolving to the global tool approval response
 */
export type RequestToolApprovalFn = (payload: PiToolCallPayload) => Promise<AgentToolApproveResponse>;

/** Adapter callbacks used to preserve framework approval semantics around Pi's narrower hook API. */
export interface PiBeforeToolCallHookOptions {
  /**
   * Store an approval-rewritten input for execution.
   * @returns true when the updated input can be applied to the target tool
   */
  onApprovedInputUpdate?: (toolCallId: string, toolName: string, updatedInput: Record<string, unknown>) => boolean;
  /** Mark the active turn as failed when approval requested hard abort. */
  onAbortRequested?: (toolName: string, message: string) => void;
}

/**
 * Runtime guard for mutable Pi tool argument objects.
 * @param value - Unknown hook argument value
 * @returns Whether the value is a record object
 */
function isToolArgsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replace a Pi-provided argument object in place.
 * @param target - Mutable Pi argument object
 * @param updatedInput - Approval-rewritten input
 */
function replaceToolArgs(target: Record<string, unknown>, updatedInput: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, updatedInput);
}

/**
 * Apply approval-rewritten input to Pi's native execution context.
 * @param context - Pi before-tool-call context
 * @param updatedInput - Approval-rewritten input
 * @returns Whether the rewrite was applied to Pi's execution args
 */
function applyUpdatedInputToPiContext(context: BeforeToolCallContext, updatedInput: Record<string, unknown>): boolean {
  if (!isToolArgsRecord(context.args)) return false;
  replaceToolArgs(context.args, updatedInput);
  replaceToolArgs(context.toolCall.arguments, updatedInput);
  return true;
}

/**
 * Transform scoped Pi tool approval payload → AgentToolApproveRequest.
 *
 * The connector emits a `ScopedToolApprovalRequest` on the scoped bus.
 * This function merges it with agent context to produce the global request.
 * @param payload - Scoped tool approval payload from the connector bus
 * @param context - Agent context used to enrich the scoped payload
 * @returns Global tool approval request for AgentSubjects.toolApprove
 */
export function toGlobalToolApproval(
  payload: ScopedToolApprovalRequest,
  context: ToolApprovalContext,
): AgentToolApproveRequest {
  return mergeScopedToolApproval(payload, context, 'pi-sdk');
}

/**
 * Register tool approval handler that bridges the connector's scoped
 * `tool_approval` subject to the global `AgentSubjects.toolApprove` bus.
 *
 * Used by both `createTestConfig` (test harness) and `agent.ts` (production)
 * via `addConnectorWiringCleanup(registerToolApprovalHandler(connector, lazyContext))`.
 *
 * The identity third argument reflects that Pi SDK uses the core
 * `AgentToolApproveResponse` schema directly — no format translation needed.
 */
export const registerToolApprovalHandler = createToolApprovalHandler(
  PiSdkSubjects.tool_approval,
  toGlobalToolApproval,
  (response: AgentToolApproveResponse) => response,
);

/**
 * Create Pi SDK's `beforeToolCall` hook bound to Makaio's approval RPC.
 *
 * Pi's `agent.beforeToolCall` is set once on the Agent instance and called
 * before every tool execution (native and custom). This factory returns an
 * async function matching Pi's hook signature.
 *
 * The adapter REPLACES the default `agent.beforeToolCall` (which delegates to
 * Pi's built-in permission system) so that Makaio takes over approval entirely.
 *
 * Approval flow:
 * 1. Pi calls the hook with `BeforeToolCallContext` before executing a tool
 * 2. Hook builds a `ScopedToolApprovalRequest` from the tool call fields
 * 3. Hook calls the bound `requestToolApproval` callback (bus round-trip)
 * 4. Returns `undefined` to allow or `{ block: true, reason }` to deny
 *
 * The hook never throws — any approval error is treated as a soft deny to
 * avoid crashing Pi's internal loop.
 * @param requestToolApproval - Bound callback that routes approval through the bus
 * @param options - Optional callbacks for applying approval side effects
 * @returns Async function matching Pi's `beforeToolCall` hook signature
 */
export function createPiBeforeToolCallHook(
  requestToolApproval: RequestToolApprovalFn,
  options: PiBeforeToolCallHookOptions = {},
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const { toolCall, args } = context;

    let response: AgentToolApproveResponse;
    try {
      response = await requestToolApproval({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: (args ?? {}) as Record<string, unknown>,
      } satisfies PiToolCallPayload);
    } catch (error) {
      // Treat bus/handler failures as a soft deny — do not propagate to Pi's loop.
      const message = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `Tool approval request failed: ${message}` };
    }

    if (response.action === 'deny') {
      const reason = response.message ?? 'Tool execution was denied.';
      if (response.shouldAbort) {
        options.onAbortRequested?.(toolCall.name, reason);
      }
      return { block: true, reason };
    }

    if (response.updatedInput !== undefined) {
      const wasStored = options.onApprovedInputUpdate?.(toolCall.id, toolCall.name, response.updatedInput) ?? false;
      const wasApplied = applyUpdatedInputToPiContext(context, response.updatedInput);
      if (!wasStored && !wasApplied) {
        return {
          block: true,
          reason: `Tool input rewrite cannot be applied to Pi tool "${toolCall.name}".`,
        };
      }
    }

    // action === 'allow': return undefined to let Pi proceed with execution
    return undefined;
  };
}
