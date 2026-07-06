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
});
