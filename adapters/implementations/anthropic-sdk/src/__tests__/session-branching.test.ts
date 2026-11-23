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
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { MakaioBus } from '@makaio/bus-core';
import type { MessageResult } from '@makaio/ai-adapters-core';
import { AnthropicSdkConnectorNamespace, AnthropicSdkConnectorSubjects } from '../namespaces/index.js';
import type { AnthropicSdkConnectorTurn } from '../turn.js';
import type { AnthropicSdkBus, AnthropicSdkSessionConfig } from '../types/index.js';
import type { SdkEvent } from '../namespaces/index.js';
import {
  AGENT_ID,
  ADAPTER_ID,
  TestAnthropicSdkSession,
  emitMessageComplete,
  makeHandle,
  makeSession,
  makeTextCompleteEvent,
  makeToolUseCompleteEvent,
  snapshotHistory,
  stubAnthropicClient,
} from './session-branching-harness.js';

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let scopedBus: AnthropicSdkBus;

beforeEach(async () => {
  MakaioBus.__resetHandlers?.();
  scopedBus = await AnthropicSdkConnectorNamespace.scopedBus(MakaioBus);
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
    session.apiCallFn = async (call, adapterSessionId) => {
      await emitMessageComplete(call, scopedBus, makeTextCompleteEvent('should not be applied'), adapterSessionId);
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

    session.apiCallFn = async (call, adapterSessionId) => {
      // Pause the current turn BEFORE emitting the message_complete event.
      // shouldAbortTurnProcessing is checked after executeStreamingStep returns.
      capturedTurn = session.getCurrentTurn();
      if (capturedTurn) {
        await capturedTurn.pause(call);
      }
      await emitMessageComplete(
        call,
        scopedBus,
        makeTextCompleteEvent('should not be applied after pause'),
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

    session.apiCallFn = async (call, adapterSessionId) => {
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
        await emitMessageComplete(call, scopedBus, makeTextCompleteEvent('response for first turn'), adapterSessionId);
      } else {
        // Second turn: emit a normal message_complete
        await emitMessageComplete(call, scopedBus, makeTextCompleteEvent('response for second turn'), adapterSessionId);
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

    session.apiCallFn = async (call, adapterSessionId) => {
      await emitMessageComplete(call, scopedBus, makeTextCompleteEvent('4'), adapterSessionId);
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

    session.apiCallFn = async (call, adapterSessionId) => {
      await emitMessageComplete(call, scopedBus, makeTextCompleteEvent('not json'), adapterSessionId);
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

    session.apiCallFn = async (call, adapterSessionId) => {
      callCount++;
      if (callCount === 2) {
        secondTurnHistory = snapshotHistory(session.getHistory());
      }
      if (callCount === 3) {
        thirdTurnHistory = snapshotHistory(session.getHistory());
      }
      await emitMessageComplete(call, scopedBus, makeTextCompleteEvent(`answer ${callCount}`), adapterSessionId);
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
    session.apiCallFn = async (call, adapterSessionId) => {
      requestHistory = snapshotHistory(session.getHistory());
      await emitMessageComplete(call, scopedBus, makeTextCompleteEvent('done'), adapterSessionId);
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

    session.apiCallFn = async (call, adapterSessionId) => {
      apiCallCount.value++;
      if (apiCallCount.value === 1) {
        // First call: respond with a tool_use finish reason
        await emitMessageComplete(
          call,
          scopedBus,
          makeToolUseCompleteEvent('tool-call-1', 'get_weather'),
          adapterSessionId,
        );
      } else {
        // Second call (after tool execution): respond with end_turn
        await emitMessageComplete(call, scopedBus, makeTextCompleteEvent('The weather is sunny.'), adapterSessionId);
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

    session.apiCallFn = async (call, adapterSessionId) => {
      callCount++;
      if (callCount === 1) {
        await emitMessageComplete(call, scopedBus, makeToolUseCompleteEvent('tc-accum-1', 'compute'), adapterSessionId);
      } else {
        await emitMessageComplete(call, scopedBus, makeTextCompleteEvent('Done.'), adapterSessionId);
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
    session.apiCallFn = async (call, adapterSessionId) => {
      callCount++;
      await emitMessageComplete(
        call,
        scopedBus,
        makeToolUseCompleteEvent(`tool-call-${callCount}`, 'looping_tool'),
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

    session.apiCallFn = async (call, adapterSessionId) => {
      callCount++;
      await emitMessageComplete(
        call,
        scopedBus,
        makeToolUseCompleteEvent(`tc-limit-${callCount}`, 'repeating_tool'),
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
    const denyConfig: AnthropicSdkSessionConfig & { globalBus: typeof MakaioBus } = {
      bus: scopedBus,
      globalBus: MakaioBus,
      adapterId: ADAPTER_ID,
      adapterName: 'anthropic-sdk-test',
      agentId: AGENT_ID,
      cwd: '/tmp',
      model: 'claude-test',
      env: {},
      client: stubAnthropicClient,
      anthropicTools: [],
      emitSdkEvent: async (call, event) => {
        const envelope: SdkEvent = { event, agentId: AGENT_ID, adapterId: ADAPTER_ID };
        await scopedBus.emit(call, AnthropicSdkConnectorSubjects.sdk.event, envelope);
      },
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'deny', message: 'Denied by test policy', shouldAbort: true }),
    };

    const denySession = new TestAnthropicSdkSession(denyConfig);

    const handle = makeHandle('msg-deny-1', 'run a tool');

    denySession.apiCallFn = async (call, adapterSessionId) => {
      await emitMessageComplete(
        call,
        scopedBus,
        makeToolUseCompleteEvent('tc-deny-1', 'restricted_tool'),
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
