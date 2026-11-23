import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { MakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { MessageHandle } from '@makaio/ai-adapters-core';
import { AnthropicSdkSession } from '../session.js';
import { AnthropicSdkConnectorSubjects } from '../namespaces/index.js';
import type { AnthropicSdkConnectorTurn } from '../turn.js';
import type { AnthropicSdkBus, AnthropicSdkSessionConfig } from '../types/index.js';
import type { MessageCompleteEvent } from '../namespaces/schemas/message.js';
import type { SdkEvent } from '../namespaces/index.js';

/** Agent identity shared by the deterministic session fixtures. */
export const AGENT_ID = 'test-agent';
/** Adapter identity shared by the deterministic session fixtures. */
export const ADAPTER_ID = 'test-adapter';

/**
 * Minimal typed stub for the Anthropic client.
 *
 * `executeApiCall` is overridden on `TestAnthropicSdkSession` and never calls
 * `super.executeApiCall`, so the real Anthropic client is never invoked.
 * Casting the stub directly to `Anthropic` avoids unsafe double-casts
 * while keeping the test free of network dependencies.
 */
export const stubAnthropicClient = {} as Anthropic;

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link MessageCompleteEvent} for text-only responses.
 * @param content - Assembled text content from the model.
 * @returns A typed `message_complete` event with `end_turn` finish reason.
 */
export function makeTextCompleteEvent(content: string): MessageCompleteEvent {
  return {
    eventType: 'message_complete',
    content,
    finish_reason: 'end_turn',
    tool_calls: undefined,
  };
}

/**
 * Build a {@link MessageCompleteEvent} that triggers a single tool call recursion.
 * @param toolCallId - Unique ID for the tool call.
 * @param toolName - Name of the tool to invoke.
 * @returns A typed `message_complete` event with `tool_use` finish reason.
 */
export function makeToolUseCompleteEvent(toolCallId: string, toolName: string): MessageCompleteEvent {
  return {
    eventType: 'message_complete',
    content: null,
    finish_reason: 'tool_use',
    tool_calls: [
      {
        id: toolCallId,
        blockIndex: 0,
        type: 'function',
        function: { name: toolName, arguments: '{}' },
      },
    ],
  };
}

/**
 * Build a {@link MessageHandle} for a plain enqueue message.
 * @param messageId - Unique message identifier.
 * @param text - User message text.
 * @returns A new `MessageHandle` in `queued` state.
 */
export function makeHandle(messageId: string, text: string): MessageHandle {
  return new MessageHandle(
    createTestCall(),
    messageId,
    { role: 'user', message: text, blocks: [{ type: 'text', content: text }] },
    'enqueue',
  );
}

/**
 * Copy message history deeply enough for assertions after the live session mutates.
 * @param history - Current Anthropic message history
 * @returns Assertion-safe snapshot
 */
export function snapshotHistory(history: MessageParam[]): MessageParam[] {
  return history.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((block) => ({ ...block }) as ContentBlockParam),
  }));
}

// ---------------------------------------------------------------------------
// Harness: TestAnthropicSdkSession
//
// Subclasses `AnthropicSdkSession` to:
// 1. Replace the real Anthropic API call with a controlled in-process emission
//    of `message_complete` events.
// 2. Expose `startNewTurn` as public so tests can invoke it directly.
//
// The `apiCallFn` callback is set per-test to control what the mock API "returns".
// ---------------------------------------------------------------------------

type ApiCallFn = (call: CallContext, adapterSessionId: string) => Promise<void>;

export class TestAnthropicSdkSession extends AnthropicSdkSession {
  /** Injected by tests to control what the mock API call emits. */
  public apiCallFn: ApiCallFn = async () => {};

  /**
   * Emit a mock `message_complete` event on the bus, bypassing real Anthropic.
   * @param turn - Turn carrying the call for the simulated API response
   * @param _abortSignal - Unused (no real stream to abort)
   * @param adapterSessionId - Forwarded to apiCallFn for envelope construction
   */
  public override async executeApiCall(
    turn: AnthropicSdkConnectorTurn,
    _abortSignal: AbortSignal,
    adapterSessionId: string,
  ): Promise<void> {
    await this.apiCallFn(turn.getMessageHandle().call, adapterSessionId);
  }

  /**
   * Expose `applyMessageComplete` as public for spy-based test assertions.
   * @param result - The parsed Anthropic `message_complete` event
   * @param currentHandle - The active message handle
   * @param toolCallIteration - Current tool recursion depth
   * @param turn - Captured turn instance for this run loop
   */
  public override async applyMessageComplete(
    result: MessageCompleteEvent,
    currentHandle: MessageHandle,
    toolCallIteration: number,
    turn: AnthropicSdkConnectorTurn,
  ): Promise<void> {
    return super.applyMessageComplete(result, currentHandle, toolCallIteration, turn);
  }

  /**
   * Expose `startNewTurn` as public for direct test invocation.
   * @param handle - The message handle to process
   * @param mergedContent - Optional merged content from superseded messages
   */
  public override async startNewTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void | false> {
    return super.startNewTurn(handle, mergedContent);
  }

  /**
   * Expose adapter history for focused session assertions.
   * @returns Current Anthropic message history
   */
  public getHistory(): MessageParam[] {
    return this.messages;
  }
}

// ---------------------------------------------------------------------------
// Helper: emit a sdk.event message_complete envelope on the bus.
//
// Mirrors what `stream-bridge.ts` does at the end of a real stream.
// The filter in `createMessageCompletePromise` matches on:
//   - event.eventType === 'message_complete'
//   - agentId
//   - adapterId
//   - adapterSessionId
// ---------------------------------------------------------------------------

/**
 * Emit a `message_complete` SDK event envelope to the shared bus.
 *
 * The base session's `createMessageCompletePromise` uses `bus.once` with a
 * filter that matches `agentId`, `adapterId`, and `adapterSessionId`, so all
 * three must be present in the envelope.
 * @param call - Call context of the turn producing the event
 * @param scopedBus - Scoped Anthropic bus instance
 * @param event - The inner `message_complete` event payload
 * @param adapterSessionId - Turn-scoped adapter session ID for filter matching
 */
export async function emitMessageComplete(
  call: CallContext,
  scopedBus: AnthropicSdkBus,
  event: MessageCompleteEvent,
  adapterSessionId: string,
): Promise<void> {
  const envelope: SdkEvent = {
    event,
    agentId: AGENT_ID,
    adapterId: ADAPTER_ID,
    adapterSessionId,
  };
  await scopedBus.emit(call, AnthropicSdkConnectorSubjects.sdk.event, envelope);
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/** Minimal tool approval that approves everything with no argument modification. */
const approveAll = async () => ({ action: 'allow' as const });

/**
 * Construct a {@link TestAnthropicSdkSession} wired to a fresh in-memory bus.
 *
 * The session is configured with no real Anthropic client — `executeApiCall`
 * is overridden on `TestAnthropicSdkSession` to use the injected `apiCallFn`.
 * @param scopedBus - Scoped bus for the Anthropic adapter namespace
 * @param adapterId - Stable adapter instance ID
 * @param agentId - Agent ID for bus filter matching and tool attribution
 * @returns A configured `TestAnthropicSdkSession` instance
 */
export function makeSession(scopedBus: AnthropicSdkBus, adapterId: string, agentId: string): TestAnthropicSdkSession {
  const config: AnthropicSdkSessionConfig & { globalBus: typeof MakaioBus } = {
    bus: scopedBus,
    globalBus: MakaioBus,
    adapterId,
    adapterName: 'anthropic-sdk-test',
    agentId,
    cwd: '/tmp',
    model: 'claude-test',
    env: {},
    // Anthropic client is unused — executeApiCall is overridden
    client: stubAnthropicClient,
    anthropicTools: [],
    emitSdkEvent: async (call, event) => {
      const envelope: SdkEvent = { event, agentId, adapterId };
      await scopedBus.emit(call, AnthropicSdkConnectorSubjects.sdk.event, envelope);
    },
    handleError: () => {},
    requestToolApproval: approveAll,
  };

  return new TestAnthropicSdkSession(config);
}
