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
});
