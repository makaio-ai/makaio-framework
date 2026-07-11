import { describe, expect, it } from 'vitest';
import type { ExtractSubjectPayload, SubjectDefinition } from '@makaio/core';
import { AgentSubjects, type StructuredOutputValidation } from '@makaio/contracts';
import { MessageHandle, type MessageResult } from '../../message-handle/index.js';
import type { AgentContext } from '../types.js';
import { MessageLifecycleTracker } from '../message-lifecycle-tracker.js';

type CapturedEmission = {
  subject: SubjectDefinition;
  payload: unknown;
};

/**
 * Create a MessageHandle with sensible test defaults.
 * @param id - Unique message identifier
 * @param content - Text content for the user message block (defaults to the id)
 * @param deliveryMode - Delivery mode (defaults to 'enqueue')
 * @returns A new MessageHandle instance
 */
function makeHandle(
  id: string,
  content?: string,
  deliveryMode?: import('@makaio/contracts').MessageDeliveryMode,
): MessageHandle {
  return new MessageHandle(
    id,
    { role: 'user', blocks: [{ type: 'text', content: content ?? id }] },
    deliveryMode ?? 'enqueue',
  );
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });

  return {
    promise,
    resolve: resolveDeferred,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MessageLifecycleTracker', () => {
  it('notifies completion observers with the transformed terminal result before completion resolves', async () => {
    const handle = makeHandle('message-observer', 'Return JSON');
    const observedMessages: Array<string | undefined> = [];

    handle.addCompletionTransform(
      (result): MessageResult => ({
        ...result,
        result: { message: '{"ok":true}' },
      }),
    );
    handle.addCompletionObserver((result) => {
      observedMessages.push(result.result?.message);
    });

    handle.markCompleted({
      outcome: 'completed',
      result: { message: 'not json' },
    });

    await expect(handle.waitForCompletion()).resolves.toEqual({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
    });
    expect(observedMessages).toEqual(['{"ok":true}']);
  });

  it('attaches structured output validation before terminal lifecycle events', async () => {
    const emissions: CapturedEmission[] = [];
    const validation: StructuredOutputValidation = { status: 'passed' };
    const validationReady = createDeferred<MessageResult>();
    const terminalObserved = createDeferred<void>();
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async (subject, payload) => {
        emissions.push({ subject, payload });
      },
    });
    const handle = makeHandle('message-1', 'Return JSON');

    tracker.track(
      handle,
      (messageId, result) => {
        emissions.push({
          subject: AgentSubjects.complete,
          payload: {
            messageId,
            message: result.result?.message,
            outcome: result.outcome,
            structuredOutputValidation: result.structuredOutputValidation,
          } satisfies Omit<ExtractSubjectPayload<typeof AgentSubjects.complete>, keyof AgentContext>,
        });
        terminalObserved.resolve();
      },
      async () => validationReady.promise,
    );

    const completion = handle.waitForCompletion();
    let completionSettled = false;
    completion.then(() => {
      completionSettled = true;
    });

    handle.markAcknowledged();
    handle.markCompleted({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
    });
    const completionResult = handle.waitForCompletion();
    await flushMicrotasks();

    expect(completionSettled).toBe(false);

    expect(emissions.map((event) => event.subject)).toEqual([
      AgentSubjects.user_message.acknowledged,
      AgentSubjects.turn.started,
    ]);

    validationReady.resolve({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
      structuredOutputValidation: validation,
    });
    await terminalObserved.promise;

    await expect(completion).resolves.toEqual({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
      structuredOutputValidation: validation,
    });

    expect(emissions.map((event) => event.subject)).toEqual([
      AgentSubjects.user_message.acknowledged,
      AgentSubjects.turn.started,
      AgentSubjects.turn.completed,
      AgentSubjects.user_message.completed,
      AgentSubjects.complete,
    ]);

    const turnCompleted = emissions.find((event) => event.subject === AgentSubjects.turn.completed);
    const agentComplete = emissions.find((event) => event.subject === AgentSubjects.complete);

    expect(turnCompleted?.payload).toEqual(
      expect.objectContaining({
        messageId: 'message-1',
        outcome: 'completed',
        structuredOutputValidation: validation,
      }),
    );
    expect(agentComplete?.payload).toEqual(
      expect.objectContaining({
        messageId: 'message-1',
        outcome: 'completed',
        structuredOutputValidation: validation,
      }),
    );
    const turnValidation = (turnCompleted?.payload as { structuredOutputValidation?: StructuredOutputValidation })
      .structuredOutputValidation;
    const completeValidation = (agentComplete?.payload as { structuredOutputValidation?: StructuredOutputValidation })
      .structuredOutputValidation;
    expect(completeValidation).toBe(turnValidation);
    await expect(completionResult).resolves.toEqual({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
      structuredOutputValidation: validation,
    });
  });

  it('passes the terminal turnId to completion observers before clearing current lifecycle state', async () => {
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async () => {},
    });
    const handle = makeHandle('message-with-turn', 'Hello');
    const observed: Array<string | undefined> = [];

    tracker.setCurrentTurnId('turn-1');
    tracker.track(handle, (_messageId, _result, turnId) => {
      observed.push(turnId);
    });

    handle.markAcknowledged();
    handle.markCompleted({
      outcome: 'completed',
      result: { message: 'Done' },
    });
    await flushMicrotasks();

    expect(observed).toEqual(['turn-1']);
    expect(tracker.getCurrentTurnId()).toBeUndefined();
  });

  it('does not fall back to current turn state when the tracked snapshot is explicitly undefined', async () => {
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async () => {},
    });
    const handle = makeHandle('message-without-turn', 'Hello');
    const observed: Array<string | undefined> = [];

    tracker.setCurrentTurnId('later-turn');
    tracker.track(
      handle,
      (_messageId, _result, turnId) => {
        observed.push(turnId);
      },
      undefined,
      { turnId: undefined },
    );

    handle.markAcknowledged();
    handle.markCompleted({
      outcome: 'completed',
      result: { message: 'Done' },
    });
    await flushMicrotasks();

    expect(observed).toEqual([undefined]);
  });

  it('exposes the tracked handle immediately at dispatch time, before acknowledgment', () => {
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handle = makeHandle('message-early', 'early');

    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
    expect(tracker.getCurrentMessageId()).toBeUndefined();

    tracker.track(handle);

    // Handle and messageId are available before acknowledgment so that
    // correlation (e.g. requestCorrelation on usage) works for result-only
    // streams that never emit user.isReplay.
    expect(tracker.getCurrentMessageHandle()).toBe(handle);
    expect(tracker.getCurrentMessageId()).toBe('message-early');

    handle.markAcknowledged();
    handle.markCompleted({ outcome: 'completed' });
  });

  it('does not let a handle tracked while another is in-flight steal the active correlation', async () => {
    // Scenario: Turn A is executing. A follow-up (Turn B) is dispatched and
    // track(handleB) is called while handleA is still the active correlation
    // source. handleB must NOT become active until handleA completes.
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handleA = makeHandle('message-a', 'A');
    const handleB = makeHandle('message-b', 'B');

    // Turn A dispatched — becomes active immediately (no prior active handle).
    tracker.track(handleA);
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // Turn B dispatched while Turn A is still in-flight — stored as pending.
    tracker.track(handleB);
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // Turn A completes — pending handleB is promoted to active.
    handleA.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBe(handleB);

    // Turn B completes — no pending, active clears.
    handleB.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
  });

  it('promotes the pending handle to active at acknowledgment time', async () => {
    // Scenario: Turn A is executing. Turn B is tracked (pending). Turn A
    // has not completed yet, but the provider acknowledges Turn B (e.g. an
    // immediate-mode supersede where the provider starts the new turn before
    // the old handle's completion promise resolves). Acknowledgment is the
    // authoritative signal that the turn is executing.
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handleA = makeHandle('message-a', 'A');
    const handleB = makeHandle('message-b', 'B');

    tracker.track(handleA);
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    tracker.track(handleB);
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // Provider acknowledges handleB (e.g. immediate-mode supersede started it).
    handleB.markAcknowledged();
    await flushMicrotasks();

    // Acknowledgment promotes handleB to active correlation source.
    expect(tracker.getCurrentMessageHandle()).toBe(handleB);

    // Clean up.
    handleA.markCompleted({ outcome: 'superseded', supersededBy: 'message-b' });
    handleB.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
  });

  it('clears a pending handle that completes before promotion (e.g. cancelled while queued)', async () => {
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handleA = makeHandle('message-a', 'A');
    const handleB = makeHandle('message-b', 'B');

    tracker.track(handleA);
    tracker.track(handleB);

    // handleB is cancelled while still pending (e.g. queue drain).
    await handleB.cancel();
    await flushMicrotasks();

    // Active handle should still be handleA — pending was cleared.
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    handleA.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
  });

  it('keeps the most recently acknowledged handle active until that handle completes', () => {
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const firstHandle = makeHandle('message-a', 'A');
    const secondHandle = makeHandle('message-b', 'B');

    tracker.acknowledge(firstHandle);
    tracker.acknowledge(secondHandle);
    tracker.complete(firstHandle, { outcome: 'completed' });

    expect(tracker.getCurrentMessageHandle()).toBe(secondHandle);

    tracker.complete(secondHandle, { outcome: 'completed' });

    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
  });

  it('keeps each tracked handle bound to its captured turnId when completions overlap', async () => {
    const emissions: CapturedEmission[] = [];
    const terminalObserved: Array<{ messageId: string; turnId: string | undefined }> = [];
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async (subject, payload) => {
        emissions.push({ subject, payload });
      },
    });
    const firstHandle = makeHandle('message-a', 'A');
    const secondHandle = makeHandle('message-b', 'B');

    tracker.setCurrentTurnId('turn-a');
    tracker.track(firstHandle, (messageId, _result, turnId) => {
      terminalObserved.push({ messageId, turnId });
    });
    tracker.setCurrentTurnId('turn-b');
    tracker.track(secondHandle, (messageId, _result, turnId) => {
      terminalObserved.push({ messageId, turnId });
    });

    firstHandle.markAcknowledged();
    secondHandle.markAcknowledged();
    await flushMicrotasks();

    secondHandle.markCompleted({
      outcome: 'completed',
      result: { message: 'B done' },
    });
    await flushMicrotasks();

    firstHandle.markCompleted({
      outcome: 'completed',
      result: { message: 'A done' },
    });
    await flushMicrotasks();

    expect(terminalObserved).toEqual([
      { messageId: 'message-b', turnId: 'turn-b' },
      { messageId: 'message-a', turnId: 'turn-a' },
    ]);

    const lifecyclePayloads = emissions.map((event) => event.payload as { messageId?: string; turnId?: string });
    expect(lifecyclePayloads.filter((payload) => payload.messageId === 'message-a')).toEqual([
      expect.objectContaining({ turnId: 'turn-a' }),
      expect.objectContaining({ turnId: 'turn-a' }),
      expect.objectContaining({ turnId: 'turn-a' }),
      expect.objectContaining({ turnId: 'turn-a' }),
    ]);
    expect(lifecyclePayloads.filter((payload) => payload.messageId === 'message-b')).toEqual([
      expect.objectContaining({ turnId: 'turn-b' }),
      expect.objectContaining({ turnId: 'turn-b' }),
      expect.objectContaining({ turnId: 'turn-b' }),
      expect.objectContaining({ turnId: 'turn-b' }),
    ]);
  });

  it('resolves getCurrentTurnId from the executing handle, not the shared field overwritten by a queued sendMessage', async () => {
    // Scenario: Turn A is streaming intermediate events when sendMessage(B)
    // arrives — it overwrites the shared currentTurnId to turn-b before B is
    // promoted. Event enrichment (agent.message/reasoning/tool) reads
    // getCurrentTurnId(); if it returned the shared field, A's remaining
    // events would carry turn-b and downstream consumers keyed on
    // turnId+messageId (e.g. SessionBridge block accumulation) would drop
    // them, losing the follow-up reply from persisted history.
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handleA = makeHandle('message-a', 'A');
    const handleB = makeHandle('message-b', 'B');

    tracker.setCurrentTurnId('turn-a');
    tracker.track(handleA);
    expect(tracker.getCurrentTurnId()).toBe('turn-a');

    // Concurrent sendMessage(B) while A is still executing.
    tracker.setCurrentTurnId('turn-b');
    tracker.track(handleB);

    // A is still the active correlation source — its events must stay turn-a.
    expect(tracker.getCurrentTurnId()).toBe('turn-a');

    // Only A is acknowledged — acknowledging B here would promote it to the
    // active slot immediately (acknowledge() is unconditional) and bypass the
    // queued-promotion path this test exercises.
    handleA.markAcknowledged();
    await flushMicrotasks();
    expect(tracker.getCurrentTurnId()).toBe('turn-a');

    // A completes → B is promoted from the queue; enrichment must switch to
    // B's captured turn-b before B is even acknowledged.
    handleA.markCompleted({ outcome: 'completed', result: { message: 'A done' } });
    await flushMicrotasks();
    expect(tracker.getCurrentTurnId()).toBe('turn-b');

    handleB.markAcknowledged();
    await flushMicrotasks();
    expect(tracker.getCurrentTurnId()).toBe('turn-b');

    handleB.markCompleted({ outcome: 'completed', result: { message: 'B done' } });
    await flushMicrotasks();
    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
  });

  it('keeps events of a handle tracked without a turn turn-less when a queued sendMessage sets the shared field', () => {
    // Scenario: a handle is intentionally tracked with turnId: undefined
    // (agent.sendMessage.turnId is optional; start() tracks without a turn).
    // While it is active, a queued sendMessage sets the shared currentTurnId.
    // The active no-turn handle must NOT inherit that later turn's id via the
    // shared-field fallback — map presence, not value, gates the fallback.
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const noTurnHandle = makeHandle('message-a', 'A');

    tracker.track(noTurnHandle, undefined, undefined, { turnId: undefined });
    expect(tracker.getCurrentTurnId()).toBeUndefined();

    // Queued follow-up announces its turn before its handle is promoted.
    tracker.setCurrentTurnId('turn-b');
    expect(tracker.getCurrentTurnId()).toBeUndefined();
  });

  it('exposes the submitted turnId independently of the executing turn for pre-track events', () => {
    // Scenario: sendMessage(B) announces turn-b while A is still executing.
    // Events describing the submitted message itself (user_message.sent,
    // emitted before B is tracked) must carry turn-b, while executing-turn
    // enrichment stays on A's captured turn-a.
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handleA = makeHandle('message-a', 'A');

    tracker.setCurrentTurnId('turn-a');
    tracker.track(handleA);

    tracker.setCurrentTurnId('turn-b');
    expect(tracker.getCurrentTurnId()).toBe('turn-a');
    expect(tracker.getSubmittedTurnId()).toBe('turn-b');
  });

  it('promotes pending handles in FIFO order when multiple are queued during an in-flight turn', async () => {
    // Scenario: Turn A is executing. Two follow-ups (B then C) are dispatched
    // while A is still active. On completion of A, B (the first queued) must be
    // promoted — not C (the last queued).
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handleA = makeHandle('message-a', 'A');
    const handleB = makeHandle('message-b', 'B');
    const handleC = makeHandle('message-c', 'C');

    // A dispatched — becomes active immediately.
    tracker.track(handleA);
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // B and C dispatched while A is in-flight — queued in FIFO order.
    tracker.track(handleB);
    tracker.track(handleC);
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // A completes — B (first queued) must be promoted, not C.
    handleA.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBe(handleB);

    // B completes — C is promoted.
    handleB.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBe(handleC);

    // C completes — no pending, active clears.
    handleC.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
  });

  it('skips a cancelled queued handle and promotes the next in FIFO order', async () => {
    // Scenario: Turn A is active. B and C are queued. B is cancelled while
    // pending. On A's completion, C (the next remaining in queue) is promoted.
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handleA = makeHandle('message-a', 'A');
    const handleB = makeHandle('message-b', 'B');
    const handleC = makeHandle('message-c', 'C');

    tracker.track(handleA);
    tracker.track(handleB);
    tracker.track(handleC);

    // B is cancelled while pending (e.g. superseded by an immediate message).
    await handleB.cancel();
    await flushMicrotasks();

    // Active handle unchanged — still A.
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // A completes — B was already removed, so C is promoted.
    handleA.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBe(handleC);

    // C completes — clears.
    handleC.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
  });

  it('tolerates an already-completed handle without throwing, promoting, or double-emitting', async () => {
    // Scenario: Shutdown gates (e.g. rejectQueuedHandles) complete the handle
    // BEFORE AIAgent.onMessageHandle() calls track(). The handle arrives at
    // track() with isProcessed === true and completionStarted === true.
    // track() must:
    //   (a) NOT throw even with a transformTerminal provided
    //   (b) NOT promote the handle to active or queue it as pending
    //   (c) still fire onTerminal and completion lifecycle events exactly once
    const emissions: CapturedEmission[] = [];
    const terminalObserved: Array<{ messageId: string; outcome: string }> = [];
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async (subject, payload) => {
        emissions.push({ subject, payload });
      },
    });

    const handle = makeHandle('message-shutdown', 'Too late');

    // Simulate shutdown gate completing the handle before track() is called.
    handle.markCompleted({ outcome: 'error', error: new Error('Session closed') });
    expect(handle.isProcessed).toBe(true);

    // track() must not throw even though transformTerminal is provided and
    // the handle's completion pipeline has already started.
    expect(() => {
      tracker.track(
        handle,
        (messageId, result) => {
          terminalObserved.push({ messageId, outcome: result.outcome });
        },
        async (result) => ({ ...result, structuredOutputValidation: { status: 'passed' as const } }),
      );
    }).not.toThrow();

    // The handle must NOT become the active correlation source or be queued.
    expect(tracker.getCurrentMessageHandle()).toBeUndefined();
    expect(tracker.getCurrentMessageId()).toBeUndefined();

    // Let the microtask queue drain so waitForCompletion resolves.
    await flushMicrotasks();

    // onTerminal must have fired exactly once.
    expect(terminalObserved).toEqual([{ messageId: 'message-shutdown', outcome: 'error' }]);

    // Lifecycle events: user_message.completed must have been emitted exactly
    // once. No acknowledged/started events because the handle was never
    // acknowledged — and therefore no turn.completed either (turn pairing
    // contract: turn.completed only fires when turn.started was emitted).
    const turnCompleted = emissions.filter((e) => e.subject === AgentSubjects.turn.completed);
    const userCompleted = emissions.filter((e) => e.subject === AgentSubjects.user_message.completed);
    const ackEvents = emissions.filter((e) => e.subject === AgentSubjects.user_message.acknowledged);
    const turnStarted = emissions.filter((e) => e.subject === AgentSubjects.turn.started);

    expect(turnCompleted).toHaveLength(0);
    expect(userCompleted).toHaveLength(1);
    expect(ackEvents).toHaveLength(0);
    expect(turnStarted).toHaveLength(0);

    expect((userCompleted[0]!.payload as { messageId: string; outcome: string }).messageId).toBe('message-shutdown');
    expect((userCompleted[0]!.payload as { outcome: string }).outcome).toBe('error');
  });

  it('does not promote a pending handle whose acknowledgment fulfills with false (undelivered)', async () => {
    // Scenario: Turn A is executing. Turn B is tracked (pending). B is
    // superseded via markCompleted() before the provider dispatches it,
    // which auto-resolves acknowledgment with false. The tracker must NOT
    // call acknowledge() for B, because that would steal the active
    // correlation slot from A's still-running turn.
    const emissions: CapturedEmission[] = [];
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async (subject, payload) => {
        emissions.push({ subject, payload });
      },
    });
    const handleA = makeHandle('message-a', 'A');
    const handleB = makeHandle('message-b', 'B');

    // A dispatched — becomes active immediately.
    tracker.track(handleA);
    handleA.markAcknowledged();
    await flushMicrotasks();
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // B dispatched while A is in-flight — queued as pending.
    tracker.track(handleB);
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // B is superseded before the provider dispatches it. markCompleted()
    // auto-resolves acknowledgment with false (delivered = false).
    handleB.markCompleted({ outcome: 'superseded', supersededBy: 'message-a' });
    await flushMicrotasks();

    // Active handle must still be A — B must NOT have been promoted.
    expect(tracker.getCurrentMessageHandle()).toBe(handleA);

    // B must have been removed from the pending queue by complete().
    // No user_message.acknowledged or turn.started events for B.
    const ackEvents = emissions.filter((e) => e.subject === AgentSubjects.user_message.acknowledged);
    expect(ackEvents).toHaveLength(1);
    expect((ackEvents[0]!.payload as { messageId: string }).messageId).toBe('message-a');

    const turnStartEvents = emissions.filter((e) => e.subject === AgentSubjects.turn.started);
    expect(turnStartEvents).toHaveLength(1);
    expect((turnStartEvents[0]!.payload as { messageId: string }).messageId).toBe('message-a');

    // A completes — no pending handles remain, active clears.
    handleA.markCompleted({ outcome: 'completed' });
    await flushMicrotasks();

    expect(tracker.getCurrentMessageHandle()).toBeUndefined();

    // Turn pairing: only A (delivered) should have turn.completed;
    // B (undelivered) should have user_message.completed but NOT turn.completed.
    const turnCompletedEvents = emissions.filter((e) => e.subject === AgentSubjects.turn.completed);
    expect(turnCompletedEvents).toHaveLength(1);
    expect((turnCompletedEvents[0]!.payload as { messageId: string }).messageId).toBe('message-a');

    const userCompletedEvents = emissions.filter((e) => e.subject === AgentSubjects.user_message.completed);
    expect(userCompletedEvents).toHaveLength(2);
    const userCompletedIds = userCompletedEvents.map((e) => (e.payload as { messageId: string }).messageId);
    expect(userCompletedIds).toContain('message-a');
    expect(userCompletedIds).toContain('message-b');
  });

  it('emits paired turn.started and turn.completed for a delivered handle', async () => {
    const emissions: CapturedEmission[] = [];
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async (subject, payload) => {
        emissions.push({ subject, payload });
      },
    });
    const handle = makeHandle('message-delivered', 'Hello');

    tracker.track(handle);
    handle.markAcknowledged();
    handle.markCompleted({ outcome: 'completed', result: { message: 'Done' } });
    await flushMicrotasks();

    const subjects = emissions.map((e) => e.subject);
    expect(subjects).toEqual([
      AgentSubjects.user_message.acknowledged,
      AgentSubjects.turn.started,
      AgentSubjects.turn.completed,
      AgentSubjects.user_message.completed,
    ]);
  });

  it('emits user_message.completed but not turn events for an undelivered handle', async () => {
    // Handle completed before dispatch (e.g. superseded while queued) —
    // acknowledgment resolves with false, no turn.started, so no turn.completed.
    const emissions: CapturedEmission[] = [];
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async (subject, payload) => {
        emissions.push({ subject, payload });
      },
    });
    const handle = makeHandle('message-undelivered', 'Superseded');

    tracker.track(handle);
    // Complete without acknowledging — simulates merge/supersede before dispatch.
    handle.markCompleted({ outcome: 'superseded', supersededBy: 'message-other' });
    await flushMicrotasks();

    const subjects = emissions.map((e) => e.subject);
    expect(subjects).toEqual([AgentSubjects.user_message.completed]);

    const userCompleted = emissions[0]!.payload as { messageId: string; outcome: string };
    expect(userCompleted.messageId).toBe('message-undelivered');
    expect(userCompleted.outcome).toBe('superseded');
  });

  it('applies the turn pairing rule to already-processed handles tracked late', async () => {
    // Handle completed by shutdown gates before track() — isProcessed is true.
    // Never acknowledged, so turn.started was never emitted. complete() must
    // NOT emit turn.completed; only user_message.completed fires.
    const emissions: CapturedEmission[] = [];
    const tracker = new MessageLifecycleTracker({
      emitGlobal: async (subject, payload) => {
        emissions.push({ subject, payload });
      },
    });
    const handle = makeHandle('message-late-track', 'Shutdown');

    // Simulate shutdown gate completing the handle before track().
    handle.markCompleted({ outcome: 'error', error: new Error('Session closed') });
    expect(handle.isProcessed).toBe(true);

    tracker.track(handle);
    await flushMicrotasks();

    const turnStarted = emissions.filter((e) => e.subject === AgentSubjects.turn.started);
    const turnCompleted = emissions.filter((e) => e.subject === AgentSubjects.turn.completed);
    const userCompleted = emissions.filter((e) => e.subject === AgentSubjects.user_message.completed);

    expect(turnStarted).toHaveLength(0);
    expect(turnCompleted).toHaveLength(0);
    expect(userCompleted).toHaveLength(1);
    expect((userCompleted[0]!.payload as { messageId: string }).messageId).toBe('message-late-track');
  });
});
