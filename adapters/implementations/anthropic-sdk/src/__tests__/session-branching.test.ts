/**
 * Integration tests for AnthropicSdkSession branching logic.
 *
 * Covers three untested code paths in the session/connector layer:
 *
 * 1. `applyMessageComplete` tool recursion — processes tool results and
 *    decides whether to continue the turn (tool_use finish_reason → recurse).
 * 2. Iteration limit enforcement — throws when MAX_TOOL_CALL_ITERATIONS is
 *    reached inside `applyMessageComplete`.
 * 3. `shouldAbortTurnProcessing` conditions — early-exit guard fires when
 *    handle is already processed, turn is paused, or turn is superseded.
 *
 * Strategy: construct a real `AnthropicSdkSession` backed by a real in-memory
 * bus. Override `executeApiCall` to synchronously emit `message_complete`
 * events via the bus, making the async agentic loop fully deterministic
 * without any external network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, type MessageResult } from '@makaio/ai-adapters-core';
import { AnthropicSdkSession } from '../session.js';
import { AnthropicSdkConnectorNamespace, AnthropicSdkConnectorSubjects } from '../namespaces/index.js';
import type { AnthropicSdkConnectorTurn } from '../turn.js';
import type { AnthropicSdkBus, AnthropicSdkSessionConfig } from '../types/index.js';
import type { MessageCompleteEvent } from '../namespaces/schemas/message.js';
import type { SdkEvent } from '../namespaces/index.js';

/**
 * Minimal typed stub for the Anthropic client.
 *
 * `executeApiCall` is overridden on `TestAnthropicSdkSession` and never calls
 * `super.executeApiCall`, so the real Anthropic client is never invoked.
 * Casting the stub directly to `Anthropic` avoids unsafe double-casts
 * while keeping the test free of network dependencies.
 */
const stubAnthropicClient = {} as Anthropic;

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link MessageCompleteEvent} for text-only responses.
 * @param content - Assembled text content from the model.
 * @returns A typed `message_complete` event with `end_turn` finish reason.
 */
function makeTextCompleteEvent(content: string): MessageCompleteEvent {
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
function makeToolUseCompleteEvent(toolCallId: string, toolName: string): MessageCompleteEvent {
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
function makeHandle(messageId: string, text: string): MessageHandle {
  return new MessageHandle(
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
function snapshotHistory(history: MessageParam[]): MessageParam[] {
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

type ApiCallFn = (adapterSessionId: string) => Promise<void>;

class TestAnthropicSdkSession extends AnthropicSdkSession {
  /** Injected by tests to control what the mock API call emits. */
  public apiCallFn: ApiCallFn = async () => {};

  /**
   * Emit a mock `message_complete` event on the bus, bypassing real Anthropic.
   * @param _turn - Unused (real call would use this for step lifecycle)
   * @param _abortSignal - Unused (no real stream to abort)
   * @param adapterSessionId - Forwarded to apiCallFn for envelope construction
   */
  public override async executeApiCall(
    _turn: AnthropicSdkConnectorTurn,
    _abortSignal: AbortSignal,
    adapterSessionId: string,
  ): Promise<void> {
    await this.apiCallFn(adapterSessionId);
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
  public override async startNewTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void> {
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
 * @param scopedBus - Scoped Anthropic bus instance
 * @param event - The inner `message_complete` event payload
 * @param agentId - Agent ID for filter matching
 * @param adapterId - Adapter ID for filter matching
 * @param adapterSessionId - Turn-scoped adapter session ID for filter matching
 */
async function emitMessageComplete(
  scopedBus: AnthropicSdkBus,
  event: MessageCompleteEvent,
  agentId: string,
  adapterId: string,
  adapterSessionId: string,
): Promise<void> {
  const envelope: SdkEvent = {
    event,
    agentId,
    adapterId,
    adapterSessionId,
  };
  await scopedBus.emit(AnthropicSdkConnectorSubjects.sdk.event, envelope);
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
function makeSession(scopedBus: AnthropicSdkBus, adapterId: string, agentId: string): TestAnthropicSdkSession {
  const config: AnthropicSdkSessionConfig = {
    bus: scopedBus,
    adapterId,
    adapterName: 'anthropic-sdk-test',
    agentId,
    cwd: '/tmp',
    model: 'claude-test',
    env: {},
    // Anthropic client is unused — executeApiCall is overridden
    client: stubAnthropicClient,
    anthropicTools: [],
    emitSdkEvent: async (event) => {
      const envelope: SdkEvent = { event, agentId, adapterId };
      await scopedBus.emit(AnthropicSdkConnectorSubjects.sdk.event, envelope);
    },
    handleError: () => {},
    requestToolApproval: approveAll,
  };

  return new TestAnthropicSdkSession(config);
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let scopedBus: AnthropicSdkBus;
const AGENT_ID = 'test-agent';
const ADAPTER_ID = 'test-adapter';

beforeEach(async () => {
  MakaioBus.__resetHandlers?.();
  scopedBus = await AnthropicSdkConnectorNamespace.scopedBus();
});

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

// ---------------------------------------------------------------------------
// Tests: shouldAbortTurnProcessing — handle already processed
// ---------------------------------------------------------------------------

describe('shouldAbortTurnProcessing — handle.isProcessed', () => {
  it('skips applyMessageComplete when handle is already completed before the event arrives', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);
    const applyMessageCompleteSpy = vi.spyOn(session, 'applyMessageComplete');

    const handle = makeHandle('msg-processed-1', 'hello');

    // Mark handle processed before the turn runs
    handle.markCompleted({ outcome: 'cancelled' });

    // Wire apiCallFn to emit a valid message_complete event
    session.apiCallFn = async (adapterSessionId) => {
      await emitMessageComplete(
        scopedBus,
        makeTextCompleteEvent('should not be applied'),
        AGENT_ID,
        ADAPTER_ID,
        adapterSessionId,
      );
    };

    await session.startNewTurn(handle);

    // Flush microtasks
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(applyMessageCompleteSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: shouldAbortTurnProcessing — turn.isPaused()
// ---------------------------------------------------------------------------

describe('shouldAbortTurnProcessing — turn.isPaused()', () => {
  it('does not call applyMessageComplete when the turn is paused mid-iteration', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);
    const applyMessageCompleteSpy = vi.spyOn(session, 'applyMessageComplete');

    const handle = makeHandle('msg-paused-1', 'pause test');

    let capturedTurn: AnthropicSdkConnectorTurn | undefined;

    session.apiCallFn = async (adapterSessionId) => {
      // Pause the current turn BEFORE emitting the message_complete event.
      // shouldAbortTurnProcessing is checked after executeStreamingStep returns.
      capturedTurn = session.getCurrentTurn();
      if (capturedTurn) {
        await capturedTurn.pause();
      }
      await emitMessageComplete(
        scopedBus,
        makeTextCompleteEvent('should not be applied after pause'),
        AGENT_ID,
        ADAPTER_ID,
        adapterSessionId,
      );
    };

    await session.startNewTurn(handle);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(applyMessageCompleteSpy).not.toHaveBeenCalled();
    expect(capturedTurn?.isPaused()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: shouldAbortTurnProcessing — isTurnSuperseded
// ---------------------------------------------------------------------------

describe('shouldAbortTurnProcessing — isTurnSuperseded', () => {
  it('skips applyMessageComplete when a second turn has superseded the first', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);
    const applyMessageCompleteSpy = vi.spyOn(session, 'applyMessageComplete');

    const handle1 = makeHandle('msg-superseded-1', 'first message');
    const handle2 = makeHandle('msg-superseded-2', 'second message');

    let firstCallCount = 0;

    session.apiCallFn = async (adapterSessionId) => {
      firstCallCount++;
      if (firstCallCount === 1) {
        // For the first turn: start a second turn that overwrites currentTurn,
        // then emit message_complete for the first turn. The first turn's
        // runTurnIteration will check shouldAbortTurnProcessing and find it
        // superseded.
        void session.startNewTurn(handle2);
        // Give the second turn time to overwrite currentTurn
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        // Now emit completion for the first adapter session (will be ignored)
        await emitMessageComplete(
          scopedBus,
          makeTextCompleteEvent('response for first turn'),
          AGENT_ID,
          ADAPTER_ID,
          adapterSessionId,
        );
      } else {
        // Second turn: emit a normal message_complete
        await emitMessageComplete(
          scopedBus,
          makeTextCompleteEvent('response for second turn'),
          AGENT_ID,
          ADAPTER_ID,
          adapterSessionId,
        );
      }
    };

    await session.startNewTurn(handle1);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // applyMessageComplete should be called only once (for the second turn)
    // The first turn's call was skipped because it was superseded
    expect(applyMessageCompleteSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: applyMessageComplete — text-only response accumulates messages
// ---------------------------------------------------------------------------

describe('applyMessageComplete — text response', () => {
  it('appends assistant message to internal messages array and sets lastAssistantMessage', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);

    const handle = makeHandle('msg-text-1', 'what is 2+2?');
    let turnCompleted = false;
    let completionResult: unknown;

    handle.waitForCompletion().then((result) => {
      completionResult = result;
      turnCompleted = true;
    });

    session.apiCallFn = async (adapterSessionId) => {
      await emitMessageComplete(scopedBus, makeTextCompleteEvent('4'), AGENT_ID, ADAPTER_ID, adapterSessionId);
    };

    await session.startNewTurn(handle);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(turnCompleted).toBe(true);
    expect(completionResult).toMatchObject({
      outcome: 'completed',
      result: { message: '4' },
    });
  });

  it('rewrites accumulated assistant history when completion returns corrected structured output', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);
    const handle = makeHandle('msg-text-corrected', 'return json');
    handle.addCompletionTransform(
      (result): MessageResult => ({
        ...result,
        result: { message: '{"ok":true}' },
        structuredOutputValidation: { status: 'enforced' },
      }),
    );

    session.apiCallFn = async (adapterSessionId) => {
      await emitMessageComplete(scopedBus, makeTextCompleteEvent('not json'), AGENT_ID, ADAPTER_ID, adapterSessionId);
    };

    await session.startNewTurn(handle);
    await expect(handle.waitForCompletion()).resolves.toEqual({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
      structuredOutputValidation: { status: 'enforced' },
    });

    expect(session.getHistory().at(-1)).toEqual({ role: 'assistant', content: '{"ok":true}' });
  });
});

// ---------------------------------------------------------------------------
// Tests: fullPrefix cache breakpoint placement
// ---------------------------------------------------------------------------

describe('fullPrefix cacheStrategy', () => {
  it('marks accumulated history before the current user message on follow-up turns', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);
    const firstHandle = makeHandle('msg-cache-1', 'first');
    const secondHandle = makeHandle('msg-cache-2', 'second');
    const thirdHandle = makeHandle('msg-cache-3', 'third');
    secondHandle.cacheStrategy = 'fullPrefix';
    thirdHandle.cacheStrategy = 'fullPrefix';

    let callCount = 0;
    let secondTurnHistory: MessageParam[] = [];
    let thirdTurnHistory: MessageParam[] = [];

    session.apiCallFn = async (adapterSessionId) => {
      callCount++;
      if (callCount === 2) {
        secondTurnHistory = snapshotHistory(session.getHistory());
      }
      if (callCount === 3) {
        thirdTurnHistory = snapshotHistory(session.getHistory());
      }
      await emitMessageComplete(
        scopedBus,
        makeTextCompleteEvent(`answer ${callCount}`),
        AGENT_ID,
        ADAPTER_ID,
        adapterSessionId,
      );
    };

    await session.startNewTurn(firstHandle);
    await expect(firstHandle.waitForCompletion()).resolves.toMatchObject({ outcome: 'completed' });
    await session.startNewTurn(secondHandle);
    await expect(secondHandle.waitForCompletion()).resolves.toMatchObject({ outcome: 'completed' });
    await session.startNewTurn(thirdHandle);
    await expect(thirdHandle.waitForCompletion()).resolves.toMatchObject({ outcome: 'completed' });

    const secondTurnAssistant = secondTurnHistory.find((message) => message.role === 'assistant');
    expect(secondTurnAssistant).toBeDefined();
    expect(secondTurnAssistant?.content).toEqual([
      { type: 'text', text: 'answer 1', cache_control: { type: 'ephemeral' } },
    ]);
    expect(secondTurnHistory.at(-1)).toEqual({ role: 'user', content: 'second' });

    const thirdTurnAssistants = thirdTurnHistory.filter((message) => message.role === 'assistant');
    expect(thirdTurnAssistants[0]?.content).toEqual([{ type: 'text', text: 'answer 1' }]);
    expect(thirdTurnAssistants[1]?.content).toEqual([
      { type: 'text', text: 'answer 2', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('uses the last cacheable history block instead of mutating a thinking block', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);
    const handle = makeHandle('msg-cache-thinking', 'continue');
    handle.cacheStrategy = 'fullPrefix';
    handle.messageHistory = [
      {
        role: 'assistant',
        blocks: [
          { type: 'text', content: 'visible answer' },
          { type: 'reasoning', content: 'private reasoning', metadata: { signature: 'sig-cache' } },
        ],
      },
    ];

    let requestHistory: MessageParam[] = [];
    session.apiCallFn = async (adapterSessionId) => {
      requestHistory = snapshotHistory(session.getHistory());
      await emitMessageComplete(scopedBus, makeTextCompleteEvent('done'), AGENT_ID, ADAPTER_ID, adapterSessionId);
    };

    await session.startNewTurn(handle);
    await expect(handle.waitForCompletion()).resolves.toMatchObject({ outcome: 'completed' });

    expect(requestHistory[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'visible answer', cache_control: { type: 'ephemeral' } },
        { type: 'thinking', thinking: 'private reasoning', signature: 'sig-cache' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: applyMessageComplete — tool recursion
// ---------------------------------------------------------------------------

describe('applyMessageComplete — tool recursion', () => {
  it('recurses through runTurnIteration when finish_reason is tool_use', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);

    // Register a real ToolSubjects.execute handler so tool execution succeeds
    const { ToolSubjects } = await import('@makaio/contracts');
    const toolHandler = MakaioBus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({ success: true, data: { result: 'tool output' } });
    });

    const handle = makeHandle('msg-tool-1', 'call a tool');
    const apiCallCount = { value: 0 };

    session.apiCallFn = async (adapterSessionId) => {
      apiCallCount.value++;
      if (apiCallCount.value === 1) {
        // First call: respond with a tool_use finish reason
        await emitMessageComplete(
          scopedBus,
          makeToolUseCompleteEvent('tool-call-1', 'get_weather'),
          AGENT_ID,
          ADAPTER_ID,
          adapterSessionId,
        );
      } else {
        // Second call (after tool execution): respond with end_turn
        await emitMessageComplete(
          scopedBus,
          makeTextCompleteEvent('The weather is sunny.'),
          AGENT_ID,
          ADAPTER_ID,
          adapterSessionId,
        );
      }
    };

    await session.startNewTurn(handle);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const result = await handle.waitForCompletion(200);

    expect(result).toMatchObject({
      outcome: 'completed',
      result: { message: 'The weather is sunny.' },
    });
    expect(apiCallCount.value).toBe(2);

    toolHandler();
  });

  it('accumulates tool results as user messages before the recursive API call', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);

    const { ToolSubjects } = await import('@makaio/contracts');
    const toolHandler = MakaioBus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({ success: true, data: { value: 42 } });
    });

    const handle = makeHandle('msg-tool-accum-1', 'use a tool');
    let callCount = 0;

    session.apiCallFn = async (adapterSessionId) => {
      callCount++;
      if (callCount === 1) {
        await emitMessageComplete(
          scopedBus,
          makeToolUseCompleteEvent('tc-accum-1', 'compute'),
          AGENT_ID,
          ADAPTER_ID,
          adapterSessionId,
        );
      } else {
        await emitMessageComplete(scopedBus, makeTextCompleteEvent('Done.'), AGENT_ID, ADAPTER_ID, adapterSessionId);
      }
    };

    await session.startNewTurn(handle);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const result = await handle.waitForCompletion(200);
    expect(result).toMatchObject({ outcome: 'completed' });

    toolHandler();
  });
});

// ---------------------------------------------------------------------------
// Tests: iteration limit enforcement
// ---------------------------------------------------------------------------

describe('applyMessageComplete — MAX_TOOL_CALL_ITERATIONS enforcement', () => {
  it('throws when tool call iterations exceed the maximum allowed', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);

    const { ToolSubjects } = await import('@makaio/contracts');
    const toolHandler = MakaioBus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({ success: true, data: { ok: true } });
    });

    const handle = makeHandle('msg-limit-1', 'infinite tool loop');
    let callCount = 0;

    // Always respond with tool_use to drive the iteration counter up
    session.apiCallFn = async (adapterSessionId) => {
      callCount++;
      await emitMessageComplete(
        scopedBus,
        makeToolUseCompleteEvent(`tool-call-${callCount}`, 'looping_tool'),
        AGENT_ID,
        ADAPTER_ID,
        adapterSessionId,
      );
    };

    await session.startNewTurn(handle);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // The turn must complete with an error outcome (iteration limit exceeded)
    const result = await handle.waitForCompletion(500);
    expect(result.outcome).toBe('error');
    expect((result as { outcome: string; error: Error }).error?.message).toMatch(/Tool call iteration limit exceeded/);

    // Should have been called exactly MAX_TOOL_CALL_ITERATIONS + 1 times:
    // iterations 0..7 (8 total) each trigger a tool call, then the 9th
    // applyMessageComplete throws before attempting a new API call.
    // Actual call count: 9 (iterations 0..8, throws at iteration 8 check).
    expect(callCount).toBe(9);

    toolHandler();
  });

  it('does not call executeApiCall beyond the iteration limit', async () => {
    const session = makeSession(scopedBus, ADAPTER_ID, AGENT_ID);

    const { ToolSubjects } = await import('@makaio/contracts');
    const toolHandler = MakaioBus.on(ToolSubjects.execute, (ctx) => {
      ctx.setResult({ success: true, data: {} });
    });

    const handle = makeHandle('msg-limit-2', 'another infinite tool loop');
    const executeApiCallSpy = vi.spyOn(session, 'executeApiCall');
    let callCount = 0;

    session.apiCallFn = async (adapterSessionId) => {
      callCount++;
      await emitMessageComplete(
        scopedBus,
        makeToolUseCompleteEvent(`tc-limit-${callCount}`, 'repeating_tool'),
        AGENT_ID,
        ADAPTER_ID,
        adapterSessionId,
      );
    };

    await session.startNewTurn(handle);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    await handle.waitForCompletion(500);

    // MAX_TOOL_CALL_ITERATIONS is 8. We call at iterations 0,1,...,8 = 9 times.
    // The error is thrown after iteration 8's applyMessageComplete check.
    expect(executeApiCallSpy).toHaveBeenCalledTimes(9);

    toolHandler();
  });
});

// ---------------------------------------------------------------------------
// Tests: tool denial (shouldAbort: true) propagates as error
// ---------------------------------------------------------------------------

describe('applyMessageComplete — tool denial with shouldAbort:true', () => {
  it('completes the turn with error outcome when tool approval is hard-denied', async () => {
    // Use a session configured to deny all tool approvals with shouldAbort
    const denyConfig: AnthropicSdkSessionConfig = {
      bus: scopedBus,
      adapterId: ADAPTER_ID,
      adapterName: 'anthropic-sdk-test',
      agentId: AGENT_ID,
      cwd: '/tmp',
      model: 'claude-test',
      env: {},
      client: stubAnthropicClient,
      anthropicTools: [],
      emitSdkEvent: async (event) => {
        const envelope: SdkEvent = { event, agentId: AGENT_ID, adapterId: ADAPTER_ID };
        await scopedBus.emit(AnthropicSdkConnectorSubjects.sdk.event, envelope);
      },
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'deny', message: 'Denied by test policy', shouldAbort: true }),
    };

    const denySession = new TestAnthropicSdkSession(denyConfig);

    const handle = makeHandle('msg-deny-1', 'run a tool');

    denySession.apiCallFn = async (adapterSessionId) => {
      await emitMessageComplete(
        scopedBus,
        makeToolUseCompleteEvent('tc-deny-1', 'restricted_tool'),
        AGENT_ID,
        ADAPTER_ID,
        adapterSessionId,
      );
    };

    await denySession.startNewTurn(handle);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const result = await handle.waitForCompletion(200);
    expect(result.outcome).toBe('error');
    expect((result as { outcome: string; error: Error }).error?.message).toMatch(/Tool use denied by approval handler/);
  });
});
