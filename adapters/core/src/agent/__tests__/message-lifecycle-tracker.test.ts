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
    const handle = new MessageHandle(
      'message-observer',
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'Return JSON' }],
      },
      'enqueue',
    );
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
    const handle = new MessageHandle(
      'message-1',
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'Return JSON' }],
      },
      'enqueue',
    );

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
    const handle = new MessageHandle(
      'message-with-turn',
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'Hello' }],
      },
      'enqueue',
    );
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
    const handle = new MessageHandle(
      'message-without-turn',
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'Hello' }],
      },
      'enqueue',
    );
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
    const handle = new MessageHandle(
      'message-early',
      { role: 'user', blocks: [{ type: 'text', content: 'early' }] },
      'enqueue',
    );

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
    const handleA = new MessageHandle(
      'message-a',
      { role: 'user', blocks: [{ type: 'text', content: 'A' }] },
      'enqueue',
    );
    const handleB = new MessageHandle(
      'message-b',
      { role: 'user', blocks: [{ type: 'text', content: 'B' }] },
      'enqueue',
    );

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
    const handleA = new MessageHandle(
      'message-a',
      { role: 'user', blocks: [{ type: 'text', content: 'A' }] },
      'enqueue',
    );
    const handleB = new MessageHandle(
      'message-b',
      { role: 'user', blocks: [{ type: 'text', content: 'B' }] },
      'enqueue',
    );

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
    const handleA = new MessageHandle(
      'message-a',
      { role: 'user', blocks: [{ type: 'text', content: 'A' }] },
      'enqueue',
    );
    const handleB = new MessageHandle(
      'message-b',
      { role: 'user', blocks: [{ type: 'text', content: 'B' }] },
      'enqueue',
    );

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
    const firstHandle = new MessageHandle(
      'message-a',
      { role: 'user', blocks: [{ type: 'text', content: 'A' }] },
      'enqueue',
    );
    const secondHandle = new MessageHandle(
      'message-b',
      { role: 'user', blocks: [{ type: 'text', content: 'B' }] },
      'enqueue',
    );

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
    const firstHandle = new MessageHandle(
      'message-a',
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'A' }],
      },
      'enqueue',
    );
    const secondHandle = new MessageHandle(
      'message-b',
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'B' }],
      },
      'enqueue',
    );

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

  it('promotes pending handles in FIFO order when multiple are queued during an in-flight turn', async () => {
    // Scenario: Turn A is executing. Two follow-ups (B then C) are dispatched
    // while A is still active. On completion of A, B (the first queued) must be
    // promoted — not C (the last queued).
    const tracker = new MessageLifecycleTracker({ emitGlobal: async () => {} });
    const handleA = new MessageHandle(
      'message-a',
      { role: 'user', blocks: [{ type: 'text', content: 'A' }] },
      'enqueue',
    );
    const handleB = new MessageHandle(
      'message-b',
      { role: 'user', blocks: [{ type: 'text', content: 'B' }] },
      'enqueue',
    );
    const handleC = new MessageHandle(
      'message-c',
      { role: 'user', blocks: [{ type: 'text', content: 'C' }] },
      'enqueue',
    );

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
    const handleA = new MessageHandle(
      'message-a',
      { role: 'user', blocks: [{ type: 'text', content: 'A' }] },
      'enqueue',
    );
    const handleB = new MessageHandle(
      'message-b',
      { role: 'user', blocks: [{ type: 'text', content: 'B' }] },
      'enqueue',
    );
    const handleC = new MessageHandle(
      'message-c',
      { role: 'user', blocks: [{ type: 'text', content: 'C' }] },
      'enqueue',
    );

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
});
