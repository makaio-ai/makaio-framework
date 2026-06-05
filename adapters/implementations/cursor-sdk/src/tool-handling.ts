/**
 * Tool approval handling for the Cursor SDK adapter.
 *
 * Centralises both approval paths for Cursor SDK:
 *
 * 1. **Scoped `tool_approval` subject** — standard adapter contract path where
 *    the connector emits a `ScopedToolApprovalRequest` on its scoped bus. Wired
 *    via the generic `createToolApprovalHandler` factory.
 *
 * 2. **Global `client:cursor.hook.handle` subject** — Cursor-specific hook
 *    subprocess path. Cursor SDK fires `preToolUse` hooks as shell commands;
 *    the `makaio hook handle cursor preToolUse` CLI bridge emits a
 *    `client:cursor.hook.handle` request on the global bus. This handler
 *    translates the hook payload into an `AgentSubjects.toolApprove` request
 *    and encodes the response as a Cursor-protocol exit code.
 *
 * Both paths converge on `AgentSubjects.toolApprove`, so the same approval
 * handler registered by tests or the runtime receives all tool approval
 * requests regardless of which path delivered them.
 * @packageDocumentation
 */

import {
  createToolApprovalHandler,
  mergeScopedToolApproval,
  type AIAgentConnector,
  type ScopedToolApprovalRequest,
  type ToolApprovalContext,
} from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AgentToolApproveRequest, type AgentToolApproveResponse } from '@makaio/contracts';
import {
  createRawClientHookHandleSubject,
  type ClientHookHandleResponse,
  type RawClientHookPayload,
} from '@makaio/subsystem-client';
import path from 'node:path';
import { CursorSdkSubjects } from './namespaces/index.js';

export type { ToolApprovalContext } from '@makaio/ai-adapters-core';

/**
 * Cursor `preToolUse` hook event name as reported by the bridge CLI.
 *
 * Used to filter hook.handle payloads so only pre-tool-use events trigger
 * the tool approval flow; all other event names pass through as no-ops.
 */
const CURSOR_HOOK_PRE_TOOL_USE = 'preToolUse';

/**
 * Default no-op response for Cursor hook.handle requests that do not require
 * special handling (exit code 0, no output, allow by default).
 */
const HOOK_NOOP_RESPONSE: ClientHookHandleResponse = { exitCode: 0, stdout: '', stderr: '' };

/**
 * Normalize a filesystem path for ownership comparisons.
 * @param filePath - Absolute or relative path to normalize.
 * @returns Normalized path without a trailing separator.
 */
function normalizeOwnedPath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const root = path.parse(resolvedPath).root;
  return resolvedPath !== root && resolvedPath.endsWith(path.sep) ? resolvedPath.slice(0, -1) : resolvedPath;
}

/**
 * Check whether a Cursor hook payload belongs to the connector.
 * @param hookPayload - Raw hook payload emitted by the Cursor bridge.
 * @param connector - Connector identity fields used for hook ownership.
 * @returns True when Cursor reports this connector's session ID or workspace root.
 */
function hookBelongsToConnector(
  hookPayload: RawClientHookPayload,
  connector: Pick<AIAgentConnector, 'cwd' | 'adapterSessionId'>,
): boolean {
  const hookSessionId = hookPayload.payload['session_id'];
  if (typeof hookSessionId === 'string') {
    return connector.adapterSessionId === hookSessionId;
  }

  const workspaceRoots = hookPayload.payload['workspace_roots'];
  if (!Array.isArray(workspaceRoots)) return false;

  const normalizedCwd = normalizeOwnedPath(connector.cwd);
  return workspaceRoots.some((root) => typeof root === 'string' && normalizeOwnedPath(root) === normalizedCwd);
}

/**
 * Transform scoped Cursor SDK tool approval payload → AgentToolApproveRequest.
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
): ReturnType<typeof mergeScopedToolApproval> {
  return mergeScopedToolApproval(payload, context, 'cursor-sdk');
}

/**
 * Wire the scoped `tool_approval` subject on the connector bus.
 *
 * This is the standard adapter-contract path created by the generic factory.
 * In the current Cursor SDK, the connector does not emit tool_approval events
 * (all approval is delivered via hooks), but the wiring is kept for forward
 * compatibility and contract conformance.
 */
const registerScopedToolApprovalHandler = createToolApprovalHandler(
  CursorSdkSubjects.tool_approval,
  toGlobalToolApproval,
  (response: AgentToolApproveResponse) => response,
);

// ---------------------------------------------------------------------------
// Hook-based tool approval bridge
// ---------------------------------------------------------------------------

/**
 * Build a deny response in the Cursor hook protocol format.
 * @param message - Human-readable denial reason.
 * @returns ClientHookHandleResponse with exit code 2 and JSON permission body.
 */
function buildDenyResponse(message: string): ClientHookHandleResponse {
  return {
    exitCode: 2,
    stdout: JSON.stringify({ permission: 'deny', agent_message: message }),
    stderr: '',
  };
}

/**
 * Register a `client:cursor.hook.handle` handler on the global bus that
 * bridges Cursor hook subprocess events into `AgentSubjects.toolApprove`.
 *
 * For `preToolUse` events: extracts `tool_name`, `tool_input`, `tool_call_id`
 * from the native payload, dispatches to `AgentSubjects.toolApprove`, and
 * encodes the response as a Cursor-protocol exit code (0 = allow, 2 = deny).
 *
 * For all other hook event names: returns a no-op allow response (exit 0).
 * @param connector - Connector identity fields used to route hook ownership.
 * @param contextProvider - Callback that resolves agent identity for the
 *   approval request. Called lazily per-request to avoid race conditions with
 *   adapterSessionId resolution.
 * @returns Cleanup function that unsubscribes from the global bus.
 */
function registerHookHandleApproval(
  connector: Pick<AIAgentConnector, 'cwd' | 'adapterSessionId'>,
  contextProvider: () => Promise<ToolApprovalContext>,
): () => void {
  const hookHandleSubject = createRawClientHookHandleSubject('cursor');

  return MakaioBus.on(hookHandleSubject, async (ctx) => {
    const hookPayload: RawClientHookPayload = ctx.payload;

    if (hookPayload.eventName !== CURSOR_HOOK_PRE_TOOL_USE) {
      ctx.setResult(HOOK_NOOP_RESPONSE);
      return;
    }

    if (!hookBelongsToConnector(hookPayload, connector)) {
      await ctx.next();
      if (ctx.result === undefined) {
        ctx.setResult(buildDenyResponse('No Cursor SDK connector owns this hook workspace'));
      }
      return;
    }

    let context: ToolApprovalContext;
    try {
      context = await contextProvider();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[registerHookHandleApproval] Failed to resolve context:', message);
      ctx.setResult(buildDenyResponse('Agent context not available for tool approval'));
      return;
    }

    const nativePayload = hookPayload.payload;
    const toolName = typeof nativePayload['tool_name'] === 'string' ? nativePayload['tool_name'] : '';
    const toolInput =
      typeof nativePayload['tool_input'] === 'object' && nativePayload['tool_input'] !== null
        ? (nativePayload['tool_input'] as Record<string, unknown>)
        : {};
    const toolCallId =
      typeof nativePayload['tool_use_id'] === 'string'
        ? nativePayload['tool_use_id']
        : typeof nativePayload['tool_call_id'] === 'string'
          ? nativePayload['tool_call_id']
          : crypto.randomUUID();

    const approvalRequest: AgentToolApproveRequest = {
      agentId: context.agentId,
      adapterId: context.adapterId,
      adapterName: context.adapterName,
      adapterSessionId: context.adapterSessionId,
      sessionId: context.sessionId,
      toolName,
      args: toolInput,
      toolCallId,
    };

    try {
      const response = await MakaioBus.request(AgentSubjects.toolApprove, approvalRequest);
      if (response.action === 'allow') {
        ctx.setResult(HOOK_NOOP_RESPONSE);
      } else {
        ctx.setResult(buildDenyResponse(response.message ?? 'Tool use denied by policy'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[registerHookHandleApproval] Tool approval request failed:', error);
      ctx.setResult(buildDenyResponse(`Tool approval request failed: ${message}`));
    }
  });
}

// ---------------------------------------------------------------------------
// Public composite registration
// ---------------------------------------------------------------------------

/**
 * Register tool approval handlers for a Cursor SDK connector.
 *
 * Wires both approval paths:
 * 1. Scoped `tool_approval` subject on the connector bus (standard contract).
 * 2. Global `client:cursor.hook.handle` subject for hook subprocess bridging.
 *
 * Returns a cleanup function that unsubscribes from both paths.
 *
 * Used by:
 * - `CursorSdkAgent.wireToolApprovalRpc` in production
 * - Conformance test harness via `testConfig.registerToolApprovalHandler`
 * @param connector - The connector (or any object with a scoped `on` method).
 * @param context - Agent identity context or lazy provider callback.
 * @returns Cleanup function that unsubscribes from both bus handlers.
 */
export function registerToolApprovalHandler(
  connector: Pick<AIAgentConnector, 'on' | 'cwd' | 'adapterSessionId'>,
  context: ToolApprovalContext | (() => Promise<ToolApprovalContext>),
): () => void {
  const unsubScoped = registerScopedToolApprovalHandler(connector, context);

  const contextProvider =
    typeof context === 'function' ? (context as () => Promise<ToolApprovalContext>) : () => Promise.resolve(context);
  const unsubHook = registerHookHandleApproval(connector, contextProvider);

  return () => {
    unsubScoped();
    unsubHook();
  };
}
