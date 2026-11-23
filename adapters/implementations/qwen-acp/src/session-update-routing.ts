/**
 * Module-level helpers of the Qwen ACP connector: the origin decision for session updates and
 * the diagnostics of observations that cannot be attributed to an operation.
 * @packageDocumentation
 */

import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';
import type { Forbid, ForbiddenKeys, MessageHandle } from '@makaio/ai-adapters-core';
import type { EmitSubject } from '@makaio/bus-core';
import type { AgentToolApproveResponse, CallContext } from '@makaio/contracts';
import type { ScopedSubjectDefinition } from '@makaio/core';
import { QwenAcpSubjects, type QwenAcpBus } from './namespaces/index.js';

/** Denial text for a filesystem request that no pending operation can be attributed to. */
export const NO_OPERATION_DENIAL = 'Tool use denied: no operation attributable to this request';

/** Emitter of one session-update callback, bound to the outcome of its ingress handle lookup. */
export type QwenUpdateEmit = <S extends ScopedSubjectDefinition<QwenAcpBus['namespace']>>(
  subject: EmitSubject<S>,
  payload: Forbid<S['$meta']['payload'], ForbiddenKeys>,
) => Promise<void>;

/** Connector emitter that forwards the call of the operation that caused the event. */
type EmitForCall = <S extends ScopedSubjectDefinition<QwenAcpBus['namespace']>>(
  call: CallContext,
  subject: EmitSubject<S>,
  payload: Forbid<S['$meta']['payload'], ForbiddenKeys>,
) => Promise<void>;

/** The `tool_call` session update. */
type AcpToolCall = Extract<SessionNotification['update'], { sessionUpdate: 'tool_call' }>;

/** The `tool_call_update` session update. */
type AcpToolCallUpdate = Extract<SessionNotification['update'], { sessionUpdate: 'tool_call_update' }>;

/** Connector emitter for observations no operation caused. */
type EmitObserved = <S extends ScopedSubjectDefinition<QwenAcpBus['namespace']>>(
  subject: EmitSubject<S>,
  payload: Forbid<S['$meta']['payload'], ForbiddenKeys>,
) => Promise<void>;

/**
 * Bind the emitters to one handle lookup outcome.
 * @param handle - Handle resolved at callback ingress, or `undefined` when none is attributable
 * @param emitForCall - Connector emitter that forwards a call
 * @param emitObserved - Connector emitter for observations
 * @returns Emitter forwarding the handle's call, or observing when there is no handle
 */
export function bindUpdateEmit(
  handle: MessageHandle | undefined,
  emitForCall: EmitForCall,
  emitObserved: EmitObserved,
): QwenUpdateEmit {
  return <S extends ScopedSubjectDefinition<QwenAcpBus['namespace']>>(
    subject: EmitSubject<S>,
    payload: Forbid<S['$meta']['payload'], ForbiddenKeys>,
  ) => (handle === undefined ? emitObserved<S>(subject, payload) : emitForCall<S>(handle.call, subject, payload));
}

/**
 * Note a tool observation that is not emitted because its schema needs the originating message
 * and no operation is attributable.
 * @param toolCallId - ACP tool call id of the dropped observation
 */
export function logDroppedToolObservation(toolCallId: string): void {
  if (process.env['MAKAIO_DEBUG']) {
    console.debug(`[qwen-acp] dropped tool observation without attributable operation: toolCallId=${toolCallId}`);
  }
}

/**
 * Emit the announcement of a tool call under the call of its operation.
 * @param emitForCall - Connector emitter that forwards a call
 * @param handle - Handle of the operation that announced the tool call
 * @param update - The ACP `tool_call` update
 * @param timestamp - Timestamp of the notification
 * @returns Resolves when the event is emitted
 */
export function emitToolCall(
  emitForCall: EmitForCall,
  handle: MessageHandle,
  update: AcpToolCall,
  timestamp: number,
): Promise<void> {
  return emitForCall<typeof QwenAcpSubjects.session_update_tool_call>(
    handle.call,
    QwenAcpSubjects.session_update_tool_call,
    {
      messageId: handle.messageId,
      toolCallId: update.toolCallId,
      title: update.title,
      kind: update.kind,
      rawInput: update.rawInput,
      timestamp,
    },
  );
}

/**
 * Emit a progress update of a tool call under the call of the operation that announced it.
 * @param emitForCall - Connector emitter that forwards a call
 * @param handle - Handle the tool call was announced under
 * @param update - The ACP `tool_call_update` update
 * @param timestamp - Timestamp of the notification
 * @returns Resolves when the event is emitted
 */
export function emitToolCallUpdate(
  emitForCall: EmitForCall,
  handle: MessageHandle,
  update: AcpToolCallUpdate,
  timestamp: number,
): Promise<void> {
  return emitForCall<typeof QwenAcpSubjects.session_update_tool_call_update>(
    handle.call,
    QwenAcpSubjects.session_update_tool_call_update,
    {
      messageId: handle.messageId,
      toolCallId: update.toolCallId,
      status: update.status ?? undefined,
      rawOutput: update.rawOutput,
      timestamp,
    },
  );
}

/**
 * Build the approval request payload of an ACP permission request.
 * @param params - Permission request from the ACP agent
 * @returns Approval request payload without connector identity
 */
export function permissionPayload(
  params: RequestPermissionRequest,
): Forbid<(typeof QwenAcpSubjects.permission_request)['$meta']['payload']['request'], ForbiddenKeys> {
  return {
    toolCallId: params.toolCall.toolCallId,
    toolName: params.toolCall.title ?? undefined,
    args:
      typeof params.toolCall.rawInput === 'object' && params.toolCall.rawInput !== null
        ? (params.toolCall.rawInput as Record<string, unknown>)
        : {},
  };
}

/**
 * Turn a denying approval response into the filesystem error the ACP agent sees.
 * Implicit allow for any non-deny action (including future action types): the
 * approval contract is allow/deny, and new actions would need contract-level
 * changes that update all callers.
 * @param response - Approval handler response
 * @param toolName - Tool identifier used in the error text
 * @throws When the response denies
 */
export function assertFsApprovalAllows(response: AgentToolApproveResponse, toolName: string): void {
  if (response.action !== 'deny') return;
  throw new Error(
    response.shouldAbort
      ? `Tool use denied by approval handler: ${response.message ?? `${toolName} denied`}`
      : (response.message ?? `${toolName} denied`),
  );
}

/** What {@link routeSessionUpdate} needs from its connector. */
export interface SessionUpdateSink {
  /** Emitter that forwards the call of the operation that caused the event. */
  readonly emitForCall: EmitForCall;
  /** Emitter for observations no operation caused. */
  readonly emitObserved: EmitObserved;
  /** Operation handle each live tool call was announced under. */
  readonly toolCallHandles: Map<string, MessageHandle>;
  /** Record (or clear) the most recent tool call id used to correlate filesystem callbacks. */
  readonly setLastToolCallId: (toolCallId: string | undefined) => void;
  /** Append streamed text to the active turn. */
  readonly appendText: (delta: string) => void;
  /**
   * Open a turn step of the given type.
   * @param call - Call of the operation that caused the update
   * @param stepType - Type of turn step to open
   */
  readonly startTurnStep: (call: CallContext, stepType: 'text' | 'tool_use') => Promise<void>;
  /**
   * Close the active turn step.
   * @param call - Call of the operation that caused the update
   */
  readonly finishActiveTurnStep: (call: CallContext) => Promise<void>;
  /** Merge per-chunk usage metadata into the turn accumulator. */
  readonly accumulateUsage: (meta: Record<string, unknown> | null | undefined) => void;
}

/**
 * Translate one ACP session update into bus events.
 *
 * `handle` is the operation resolved at callback ingress and forwarded for the whole update.
 * Without one, text and window updates are observations; tool updates carry the originating
 * message in their schema, so they are dropped (with a debug note) instead of inventing it.
 * @param update - The ACP session update
 * @param timestamp - Timestamp of the notification
 * @param handle - Operation handle captured at callback ingress, or `undefined` when none is attributable
 * @param sink - Connector operations the update drives
 * @returns Resolves when every event of the update is emitted
 */
export async function routeSessionUpdate(
  update: SessionNotification['update'],
  timestamp: number,
  handle: MessageHandle | undefined,
  sink: SessionUpdateSink,
): Promise<void> {
  const emitUpdate = bindUpdateEmit(handle, sink.emitForCall, sink.emitObserved);
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const delta = update.content.type === 'text' ? update.content.text : '';
      sink.appendText(delta);
      if (handle !== undefined) await sink.startTurnStep(handle.call, 'text');
      await emitUpdate<typeof QwenAcpSubjects.session_update_message_chunk>(
        QwenAcpSubjects.session_update_message_chunk,
        { delta, timestamp },
      );
      sink.accumulateUsage(update._meta);
      break;
    }
    case 'agent_thought_chunk': {
      const delta = update.content.type === 'text' ? update.content.text : '';
      await emitUpdate<typeof QwenAcpSubjects.session_update_thought_chunk>(
        QwenAcpSubjects.session_update_thought_chunk,
        { delta, timestamp },
      );
      break;
    }
    case 'tool_call': {
      if (handle !== undefined) sink.toolCallHandles.set(update.toolCallId, handle);
      sink.setLastToolCallId(update.toolCallId);
      if (handle !== undefined) {
        await sink.finishActiveTurnStep(handle.call);
        await sink.startTurnStep(handle.call, 'tool_use');
      }
      if (handle === undefined) logDroppedToolObservation(update.toolCallId);
      else await emitToolCall(sink.emitForCall, handle, update, timestamp);
      break;
    }
    case 'tool_call_update': {
      const toolHandle = sink.toolCallHandles.get(update.toolCallId);
      if (toolHandle === undefined) logDroppedToolObservation(update.toolCallId);
      else await emitToolCallUpdate(sink.emitForCall, toolHandle, update, timestamp);
      if (update.status === 'completed' || update.status === 'failed') {
        sink.toolCallHandles.delete(update.toolCallId);
        sink.setLastToolCallId(undefined);
        if (toolHandle !== undefined) await sink.finishActiveTurnStep(toolHandle.call);
      }
      break;
    }
    case 'usage_update':
      await emitUpdate<typeof QwenAcpSubjects.session_update_context_window>(
        QwenAcpSubjects.session_update_context_window,
        { size: update.size, used: update.used, timestamp },
      );
      break;
    default:
      break;
  }
}
