/**
 * Tests for CodexAppServerConnector - Complete
 *
 * Tests complete functionality:
 * - Waiting for idle state before completing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { CallContext, Party } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { CodexAppServerNamespace } from '../namespaces/index.js';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithThread,
  createMockThread,
  createMockTurn,
  type ConnectorTestContext,
} from './shared.js';

describe('CodexAppServerConnector - Complete', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('should wait for idle state before completing', async () => {
    await startConnectorWithThread(ctx, 'Test');

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    // Start complete() call (should wait)
    const completePromise = ctx.connector.complete();

    // Turn completes after delay
    setTimeout(() => {
      ctx.mockJsonRpcClient
        .receiveNotification('turn/completed', {
          threadId: 'thread-123',
          turn: { id: 'turn-456', status: 'completed' },
        })
        .catch((err: unknown) => {
          console.error('Test notification failed:', err);
        });
    }, 10);

    await expect(completePromise).resolves.toBeDefined();
  });

  it('uses the authoritative completed agent message when structured output has no deltas', async () => {
    await startConnectorWithThread(ctx, 'Return structured output');
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await ctx.mockJsonRpcClient.receiveNotification('item/completed', {
      threadId: 'thread-123',
      turnId: 'turn-456',
      item: { type: 'agentMessage', id: 'message-1', text: '{"status":"ok"}' },
    });
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-456', status: 'completed' },
    });

    await expect(ctx.connector.complete()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: '{"status":"ok"}' },
    });
  });

  it('uses the agent message carried by turn completion when no item notification arrived', async () => {
    await startConnectorWithThread(ctx, 'Return structured output');
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: {
        id: 'turn-456',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'message-1', text: '{"status":"ok"}' }],
      },
    });

    await expect(ctx.connector.complete()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: '{"status":"ok"}' },
    });
  });

  it('propagates failed turn completion instead of synthesizing an empty successful response', async () => {
    await startConnectorWithThread(ctx, 'Return structured output');
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: {
        id: 'turn-456',
        status: 'failed',
        items: [],
        error: { message: 'schema rejected', codexErrorInfo: null, additionalDetails: null },
      },
    });

    await expect(ctx.connector.complete()).resolves.toMatchObject({
      outcome: 'error',
      error: expect.objectContaining({ message: 'schema rejected' }),
    });
  });
});

describe('CodexAppServerConnector - call attribution of turn notifications', () => {
  const PERSON_A: Party = { kind: 'acme.person', id: 'person-a' };
  const PERSON_B: Party = { kind: 'acme.person', id: 'person-b' };
  let ctx: ConnectorTestContext;
  const deltaPrincipals: Array<{ turnId: string; principal: Party }> = [];
  const finalMessages: Array<{ message: string; principal: Party }> = [];

  /**
   * Let every queued notification handler run to its next suspension point.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  /**
   * Start the connector under `call` and complete the thread startup.
   * @param call - Call of the start operation
   */
  async function startUnderCall(call: CallContext): Promise<void> {
    const started = ctx.connector.start(
      { role: 'user', message: 'First', blocks: [{ type: 'text', content: 'First' }] },
      { call },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.mockJsonRpcClient.receiveNotification('thread/started', { thread: createMockThread() });
    await started;
  }

  /**
   * Send an agent message delta for a provider turn.
   * @param turnId - Provider turn id the delta carries
   */
  async function sendDelta(turnId: string): Promise<void> {
    await ctx.mockJsonRpcClient.receiveNotification('item/agentMessage/delta', {
      threadId: 'thread-123',
      turnId,
      delta: `delta of ${turnId}`,
    });
    await settle();
  }

  /**
   * Send a `turn/completed` notification that carries a final agent message.
   * @param turnId - Provider turn id that completed
   * @param text - Final agent message text
   */
  async function sendCompleted(turnId: string, text: string): Promise<void> {
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', id: `message-${turnId}`, text }] },
    });
    await settle();
  }

  beforeEach(async () => {
    deltaPrincipals.length = 0;
    finalMessages.length = 0;
    ctx = await createConnectorTestContext();
    ctx.mockBus.on(CodexAppServerNamespace.subjects.agent_message_delta, (busCtx) => {
      deltaPrincipals.push({ turnId: busCtx.payload.turnId, principal: busCtx.call.principal });
    });
    ctx.mockBus.on(CodexAppServerNamespace.subjects.agent_message, (busCtx) => {
      finalMessages.push({ message: busCtx.payload.message, principal: busCtx.call.principal });
    });
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('emits the completed-turn message under the call of the handle', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    await sendCompleted('turn-456', 'final answer');

    expect(finalMessages).toEqual([{ message: 'final answer', principal: PERSON_A }]);
  });

  it('emits a delta without an attributable handle with the observer context instead of dropping it', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    await sendDelta('turn-not-pending');

    expect(deltaPrincipals).toHaveLength(1);
    expect(deltaPrincipals[0]?.turnId).toBe('turn-not-pending');
    expect(deltaPrincipals[0]?.principal).not.toEqual(PERSON_A);
  });

  it('attributes a delta to its own turn while the queued turn/started handler has not run', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    // Hold the notification queue: the step_finished state change of an earlier notification waits on the gate.
    const gate = Promise.withResolvers<void>();
    ctx.connector.onProcessingStateChanged(async (state) => {
      if (state === 'step_finished') await gate.promise;
    });
    await ctx.mockJsonRpcClient.receiveNotification('item/completed', {
      threadId: 'thread-123',
      turnId: 'turn-456',
      item: { type: 'agentMessage', id: 'message-0', text: 'earlier' },
    });
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await settle();
    expect(ctx.connector.getProcessingState()).not.toBe('processing_started');

    await sendDelta('turn-456');
    gate.resolve();
    await settle();

    expect(deltaPrincipals).toEqual([{ turnId: 'turn-456', principal: PERSON_A }]);
  });

  it('never gives traffic of a replaced turn the call of the replacing handle', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();
    // Message B waits behind A; completing A installs B's handle before B's provider turn id arrives.
    await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    await sendCompleted('turn-a', 'answer a');
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);

    await sendDelta('turn-a');
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendDelta('turn-b');

    expect(deltaPrincipals).toHaveLength(2);
    expect(deltaPrincipals[0]?.turnId).toBe('turn-a');
    expect(deltaPrincipals[0]?.principal).not.toEqual(PERSON_A);
    expect(deltaPrincipals[0]?.principal).not.toEqual(PERSON_B);
    expect(deltaPrincipals[1]).toEqual({ turnId: 'turn-b', principal: PERSON_B });
  });

  it('ignores a replayed completion without emitting again or settling the newer turn', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();
    await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    // turn-a completes normally; the queue drains straight into turn-b.
    await sendCompleted('turn-a', 'answer a');
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);

    let completeResolved = false;
    const completePromise = ctx.connector.complete().then((result) => {
      completeResolved = true;
      return result;
    });

    // Replay the same terminal snapshot after turn-b takes the dispatch slot.
    await sendCompleted('turn-a', 'answer a');
    expect(finalMessages).toEqual([{ message: 'answer a', principal: PERSON_A }]);
    expect(completeResolved).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendCompleted('turn-b', 'answer b');

    await expect(completePromise).resolves.toMatchObject({ outcome: 'completed', result: { message: 'answer b' } });
    expect(finalMessages).toContainEqual({ message: 'answer b', principal: PERSON_B });
  });

  it('observes an unfinished provider turn completing after a newer provider turn takes its slot', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    for (const id of ['turn-a', 'turn-b']) {
      await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
        threadId: 'thread-123',
        turn: createMockTurn({ id }),
      });
    }
    await settle();
    const stateBefore = ctx.connector.getProcessingState();

    await sendCompleted('turn-a', 'answer a');
    await sendCompleted('turn-a', 'answer a');

    const observed = { message: 'answer a', principal: MakaioBus.own('observer').principal };
    expect(finalMessages).toEqual([observed]);
    expect(ctx.connector.getProcessingState()).toBe(stateBefore);

    await sendCompleted('turn-b', 'answer b');

    await expect(ctx.connector.complete()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer b' },
    });
    expect(finalMessages).toEqual([observed, { message: 'answer b', principal: PERSON_A }]);
  });

  it('keeps completion ownership across an await: a message sent while settlement is suspended is queued, not dispatched', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();
    // Drive turn-a through an item lifecycle so its own state machine reaches 'step_finished':
    // only from there does the later turn/completed notification flip it to 'turn_finished'
    // synchronously, before its state-change emission is awaited (the race this test covers).
    await ctx.mockJsonRpcClient.receiveNotification('item/started', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: '' },
    });
    await settle();
    await ctx.mockJsonRpcClient.receiveNotification('item/completed', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: 'answer a' },
    });
    await settle();

    // Gate the turn's own 'turn_finished' state-change emission. By the time this fires, the
    // turn's internal state already flipped synchronously (isCompleted() reads true), but
    // onTurnCompleted has not yet re-read any further connector state.
    const gate = Promise.withResolvers<void>();
    let gated = false;
    ctx.mockBus.on(CodexAppServerNamespace.subjects.turn_state_changed, async (busCtx) => {
      if (!gated && busCtx.payload.newState === 'turn_finished') {
        gated = true;
        await gate.promise;
      }
    });

    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'item-a', text: 'answer a' }] },
    });
    await settle();

    // While A's completion is suspended inside its own turn-state emission, a new message is
    // dispatched: admission tests the dispatch slot, not the turn's own completed flag, and the
    // slot is still held by A (onTurnCompleted releases it only as the last step of its own
    // finishing sequence), so B is enqueued instead of starting immediately.
    const handleB = await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(handleB.isProcessed).toBe(false);

    gate.resolve();
    await settle();

    // A's own completion settles only A; B must still be pending, not cleared or completed
    // with A's result, but A's completion has now dispatched it from the queue.
    expect(finalMessages).toEqual([{ message: 'answer a', principal: PERSON_A }]);
    expect(handleB.isProcessed).toBe(false);
    expect(handleB.getState()).not.toBe('completed');
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendCompleted('turn-b', 'answer b');

    await expect(handleB.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer b' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer b', principal: PERSON_B });
  });

  it("does not go idle while a message queued during A's connector-level lifecycle emission is live", async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();

    // Gate the connector's own 'turn_finished' processing-state transition, which onTurnCompleted
    // awaits after settling A's handle and before releasing the dispatch slot.
    const gate = Promise.withResolvers<void>();
    let gated = false;
    ctx.connector.onProcessingStateChanged(async (state) => {
      if (!gated && state === 'turn_finished') {
        gated = true;
        await gate.promise;
      }
    });

    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'item-a', text: 'answer a' }] },
    });
    await settle();

    // The slot is still held while A's lifecycle emission is suspended: B is enqueued, and the
    // connector must not report idle while B is queued/live.
    const handleB = await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(ctx.connector.getProcessingState()).not.toBe('idle');
    expect(handleB.isProcessed).toBe(false);

    gate.resolve();
    await settle();

    // A's completion dispatches B from the queue instead of going idle.
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(ctx.connector.getProcessingState()).not.toBe('idle');
    expect(handleB.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendCompleted('turn-b', 'answer b');

    await expect(ctx.connector.complete()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer b' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer a', principal: PERSON_A });
    expect(finalMessages).toContainEqual({ message: 'answer b', principal: PERSON_B });
  });

  it("dispatches a superseding immediate message and a later queued message in order, without either overwriting the other's turn or handle, even while A's lifecycle emission is suspended", async () => {
    const started = ctx.connector.start(
      { role: 'user', message: 'First', blocks: [{ type: 'text', content: 'First' }] },
      { call: createTestCall({ principal: PERSON_A }) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.mockJsonRpcClient.receiveNotification('thread/started', { thread: createMockThread() });
    const { messageHandle: handleA } = await started;
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();

    // An immediate message arrives while A is still active: it waits in the queue and is found
    // by A's completion, which dispatches it through the superseding fast path — superseding A's
    // own handle, not the immediate message's.
    const handleImmediate = await ctx.connector.sendMessage(
      { role: 'user', message: 'Immediate', blocks: [{ type: 'text', content: 'Immediate' }] },
      { call: createTestCall({ principal: PERSON_B }), deliveryMode: 'immediate' },
    );

    // Gate the connector's own 'turn_finished' processing-state transition inside the immediate
    // (supersede) fast path.
    const gate = Promise.withResolvers<void>();
    let gated = false;
    ctx.connector.onProcessingStateChanged(async (state) => {
      if (!gated && state === 'turn_finished') {
        gated = true;
        await gate.promise;
      }
    });

    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [] },
    });
    await settle();

    // A third message arrives while A's immediate-path lifecycle emission is suspended: the slot
    // is still held by A, so it is enqueued, not started.
    const handleC = await ctx.connector.sendMessage(
      { role: 'user', message: 'Third', blocks: [{ type: 'text', content: 'Third' }] },
      { call: createTestCall({ principal: PERSON_A }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(handleC.isProcessed).toBe(false);

    gate.resolve();
    await settle();

    // The immediate message is dispatched as its own turn; C has not overwritten its turn or
    // handle, A's own handle is settled as superseded by the immediate message, and C itself is
    // still pending behind it.
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    await expect(handleA.waitForCompletion()).resolves.toMatchObject({
      outcome: 'superseded',
      supersededBy: handleImmediate.messageId,
    });
    expect(handleImmediate.isProcessed).toBe(false);
    expect(handleC.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-immediate' }),
    });
    await settle();
    await sendCompleted('turn-immediate', 'answer immediate');

    // C is dispatched only once the immediate message's own turn has completed.
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(3);
    await expect(handleImmediate.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer immediate' },
    });

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-c' }),
    });
    await settle();
    await sendCompleted('turn-c', 'answer c');

    await expect(handleC.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer c' },
    });
  });

  it('releases the dispatch slot and dispatches a queued message even when the turn_finished emission rejects (normal path)', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();

    ctx.connector.onProcessingStateChanged((state) => {
      if (state === 'turn_finished') throw new Error('turn_finished subscriber rejected');
    });

    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'item-a', text: 'answer a' }] },
    });
    await settle();

    // Without the fix the rejected emission strands the slot forever: this send would stay
    // queued and the connector would never issue a second `turn/start`.
    const handleB = await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleB.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendCompleted('turn-b', 'answer b');

    await expect(handleB.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer b' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer b', principal: PERSON_B });
  });

  it('releases the dispatch slot and dispatches a queued message even when the processing_finished emission rejects (normal path)', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();

    ctx.connector.onProcessingStateChanged((state) => {
      if (state === 'processing_finished') throw new Error('processing_finished subscriber rejected');
    });

    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'item-a', text: 'answer a' }] },
    });
    await settle();

    const handleB = await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleB.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendCompleted('turn-b', 'answer b');

    await expect(handleB.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer b' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer b', principal: PERSON_B });
  });

  it('releases the dispatch slot and dispatches the superseding immediate message even when the turn_finished emission rejects (immediate path)', async () => {
    const started = ctx.connector.start(
      { role: 'user', message: 'First', blocks: [{ type: 'text', content: 'First' }] },
      { call: createTestCall({ principal: PERSON_A }) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.mockJsonRpcClient.receiveNotification('thread/started', { thread: createMockThread() });
    await started;
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();

    // An immediate message waits in the queue; A's completion finds it and takes the
    // superseding fast path.
    const handleImmediate = await ctx.connector.sendMessage(
      { role: 'user', message: 'Immediate', blocks: [{ type: 'text', content: 'Immediate' }] },
      { call: createTestCall({ principal: PERSON_B }), deliveryMode: 'immediate' },
    );

    ctx.connector.onProcessingStateChanged((state) => {
      if (state === 'turn_finished') throw new Error('turn_finished subscriber rejected');
    });

    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [] },
    });
    await settle();

    // Without the fix the rejected emission strands the slot before the immediate message is
    // ever started: this would never reach a second `turn/start`.
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleImmediate.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-immediate' }),
    });
    await settle();
    await sendCompleted('turn-immediate', 'answer immediate');

    await expect(handleImmediate.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer immediate' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer immediate', principal: PERSON_B });
  });

  it("dispatches a queued message as its own turn when a subscriber rejects during the turn's own completion (normal path)", async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();
    // Drive turn-a through an item lifecycle so its own state machine reaches 'step_finished':
    // only from there does the later turn/completed notification flip it to 'turn_finished' and
    // emit turn_state_changed / turn_completed from inside turn.handleTurnCompleted().
    await ctx.mockJsonRpcClient.receiveNotification('item/started', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: '' },
    });
    await settle();
    await ctx.mockJsonRpcClient.receiveNotification('item/completed', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: 'answer a' },
    });
    await settle();

    let threw = false;
    ctx.mockBus.on(CodexAppServerNamespace.subjects.turn_state_changed, (busCtx) => {
      if (!threw && busCtx.payload.newState === 'turn_finished') {
        threw = true;
        throw new Error('turn_state_changed subscriber rejected');
      }
    });

    // Without the fix, a rejection here (inside turn.handleTurnCompleted(), before the slot's own
    // finally) would strand the slot forever: this send would stay queued and the connector would
    // never issue a second `turn/start`.
    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'item-a', text: 'answer a' }] },
    });
    await settle();

    const handleB = await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleB.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendCompleted('turn-b', 'answer b');

    await expect(handleB.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer b' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer b', principal: PERSON_B });
  });

  it("dispatches the superseding immediate message as its own turn when a subscriber rejects during the turn's own completion (immediate path)", async () => {
    const started = ctx.connector.start(
      { role: 'user', message: 'First', blocks: [{ type: 'text', content: 'First' }] },
      { call: createTestCall({ principal: PERSON_A }) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.mockJsonRpcClient.receiveNotification('thread/started', { thread: createMockThread() });
    await started;
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();
    // Drive turn-a to 'step_finished' so turn.handleTurnCompleted() actually transitions it (and
    // emits) rather than being a no-op, same precondition as the normal-path sibling above.
    await ctx.mockJsonRpcClient.receiveNotification('item/started', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: '' },
    });
    await settle();
    await ctx.mockJsonRpcClient.receiveNotification('item/completed', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: '' },
    });
    await settle();

    // An immediate message waits in the queue; A's completion finds it and takes the superseding
    // fast path once the turn's own completion (below) has resolved.
    const handleImmediate = await ctx.connector.sendMessage(
      { role: 'user', message: 'Immediate', blocks: [{ type: 'text', content: 'Immediate' }] },
      { call: createTestCall({ principal: PERSON_B }), deliveryMode: 'immediate' },
    );

    let threw = false;
    ctx.mockBus.on(CodexAppServerNamespace.subjects.turn_state_changed, (busCtx) => {
      if (!threw && busCtx.payload.newState === 'turn_finished') {
        threw = true;
        throw new Error('turn_state_changed subscriber rejected');
      }
    });

    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [] },
    });
    await settle();

    // Without the fix the rejection strands the slot before the immediate message is ever
    // started: this would never reach a second `turn/start`.
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleImmediate.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-immediate' }),
    });
    await settle();
    await sendCompleted('turn-immediate', 'answer immediate');

    await expect(handleImmediate.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer immediate' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer immediate', principal: PERSON_B });
  });

  it('dispatches a queued message as its own turn when the final agent_message emission rejects (normal path)', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();

    let threw = false;
    ctx.mockBus.on(CodexAppServerNamespace.subjects.agent_message, () => {
      if (!threw) {
        threw = true;
        throw new Error('agent_message subscriber rejected');
      }
    });

    // Without the fix, a rejection here (emitted before markCompletedWithFinalResult, still
    // outside the old helper's own try/finally) would strand the slot forever.
    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'item-a', text: 'answer a' }] },
    });
    await settle();

    const handleB = await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleB.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendCompleted('turn-b', 'answer b');

    await expect(handleB.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer b' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer b', principal: PERSON_B });
  });

  it('releases the dispatch slot and dispatches the superseding immediate message even when the processing_finished emission rejects (immediate path)', async () => {
    const started = ctx.connector.start(
      { role: 'user', message: 'First', blocks: [{ type: 'text', content: 'First' }] },
      { call: createTestCall({ principal: PERSON_A }) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.mockJsonRpcClient.receiveNotification('thread/started', { thread: createMockThread() });
    await started;
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();

    // An immediate message waits in the queue; A's completion finds it and takes the superseding
    // fast path.
    const handleImmediate = await ctx.connector.sendMessage(
      { role: 'user', message: 'Immediate', blocks: [{ type: 'text', content: 'Immediate' }] },
      { call: createTestCall({ principal: PERSON_B }), deliveryMode: 'immediate' },
    );

    ctx.connector.onProcessingStateChanged((state) => {
      if (state === 'processing_finished') throw new Error('processing_finished subscriber rejected');
    });

    void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-a', status: 'completed', items: [] },
    });
    await settle();

    // Without the fix the rejected emission strands the slot after the immediate message has
    // already been started: a message after this one would still never dispatch.
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleImmediate.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-immediate' }),
    });
    await settle();
    await sendCompleted('turn-immediate', 'answer immediate');

    await expect(handleImmediate.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer immediate' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer immediate', principal: PERSON_B });
  });

  it('keeps the original completion failure as a secondary error when the idle dispatch decision also rejects (normal path)', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();
    // Drive turn-a to 'step_finished' so turn.handleTurnCompleted() actually transitions it (and
    // emits turn_completed) rather than being a no-op.
    await ctx.mockJsonRpcClient.receiveNotification('item/started', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: '' },
    });
    await settle();
    await ctx.mockJsonRpcClient.receiveNotification('item/completed', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: 'answer a' },
    });
    await settle();

    const completionError = new Error('turn_completed subscriber rejected');
    const idleError = new Error('idle processing-state subscriber rejected');
    ctx.mockBus.on(CodexAppServerNamespace.subjects.turn_completed, () => {
      throw completionError;
    });
    // The queue is empty, so the completion's dispatch decision is the idle transition: make it
    // reject too, so onTurnCompleted's own rejection must carry both failures.
    ctx.connector.onProcessingStateChanged((state) => {
      if (state === 'idle') throw idleError;
    });

    // onTurnCompleted runs behind the connector's serialized notification queue, which logs a
    // rejection instead of throwing back into the notification call: capture that log to observe
    // the handler's own rejection, the same path every other rejection test's notification goes
    // through.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
        threadId: 'thread-123',
        turn: { id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'item-a', text: 'answer a' }] },
      });
      await settle();

      const loggedCall = consoleErrorSpy.mock.calls.find(
        (call) => call[0] === '[CodexAppServerConnector] Notification handler error:',
      );
      expect(loggedCall?.[1]).toBeInstanceOf(AggregateError);
      const aggregate = loggedCall?.[1] as AggregateError;
      expect(aggregate.errors).toEqual([completionError, idleError]);
    } finally {
      consoleErrorSpy.mockRestore();
    }

    // The slot is released despite both failures: a later send dispatches as its own turn.
    const handleB = await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleB.isProcessed).toBe(false);
  });

  it('propagates the original completion failure, unmasked, when the turn_completed subscriber rejects alone (normal path)', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-a' }),
    });
    await settle();
    await ctx.mockJsonRpcClient.receiveNotification('item/started', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: '' },
    });
    await settle();
    await ctx.mockJsonRpcClient.receiveNotification('item/completed', {
      threadId: 'thread-123',
      turnId: 'turn-a',
      item: { type: 'agentMessage', id: 'item-a', text: 'answer a' },
    });
    await settle();

    const completionError = new Error('turn_completed subscriber rejected');
    ctx.mockBus.on(CodexAppServerNamespace.subjects.turn_completed, () => {
      throw completionError;
    });

    // Direct coverage for the gap the review named: a rejecting turn_completed subscriber alone
    // (dispatch itself succeeds), observed through the same notification error path as above.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      void ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
        threadId: 'thread-123',
        turn: { id: 'turn-a', status: 'completed', items: [{ type: 'agentMessage', id: 'item-a', text: 'answer a' }] },
      });
      await settle();

      const loggedCall = consoleErrorSpy.mock.calls.find(
        (call) => call[0] === '[CodexAppServerConnector] Notification handler error:',
      );
      expect(loggedCall?.[1]).toBe(completionError);
    } finally {
      consoleErrorSpy.mockRestore();
    }

    const handleB = await ctx.connector.sendMessage(
      { role: 'user', message: 'Second', blocks: [{ type: 'text', content: 'Second' }] },
      { call: createTestCall({ principal: PERSON_B }) },
    );
    expect(ctx.mockJsonRpcClient.sentRequests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(handleB.isProcessed).toBe(false);

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-b' }),
    });
    await settle();
    await sendCompleted('turn-b', 'answer b');

    await expect(handleB.waitForCompletion()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: 'answer b' },
    });
    expect(finalMessages).toContainEqual({ message: 'answer b', principal: PERSON_B });
  });

  it('ignores a replay with different content after the connector returns to idle', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await sendCompleted('turn-456', 'answer');
    const settled = await ctx.connector.complete();

    await sendCompleted('turn-456', 'late answer');

    expect(finalMessages).toEqual([{ message: 'answer', principal: PERSON_A }]);
    await expect(ctx.connector.complete()).resolves.toBe(settled);
  });

  it('observes the final message of a provider turn started with no pending handle', async () => {
    await ctx.connector.initialize({ call: createTestCall() });
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    await sendCompleted('turn-456', 'provider answer');
    await sendCompleted('turn-456', 'replayed answer');

    expect(finalMessages).toEqual([{ message: 'provider answer', principal: MakaioBus.own('observer').principal }]);
    await expect(ctx.connector.complete()).resolves.toBeNull();
  });

  it('releases provider turn IDs as a long sequence of turns completes', async () => {
    await startUnderCall(createTestCall({ principal: PERSON_A }));
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await sendCompleted('turn-456', 'local answer');

    const turnCount = 128;
    for (let index = 0; index < turnCount; index++) {
      const id = `provider-turn-${index}`;
      await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
        threadId: 'thread-123',
        turn: createMockTurn({ id }),
      });
      await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
        threadId: 'thread-123',
        turn: { id, status: 'completed', items: [{ type: 'agentMessage', id: `message-${id}`, text: id }] },
      });
    }
    await ctx.connector['notificationQueue'];

    expect(finalMessages).toHaveLength(turnCount + 1);
    expect(ctx.connector['turnCtx'].unfinishedProviderTurnIds.size).toBe(0);
  });
});
