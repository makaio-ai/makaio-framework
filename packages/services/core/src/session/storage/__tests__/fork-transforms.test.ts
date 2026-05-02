import { describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../namespace.js';
import { createSession, useDrizzleTestLifecycle } from './shared.js';

/**
 * Tests for forkTransforms JSON serialization/deserialization in session storage.
 *
 * Verifies that the storage layer correctly handles the forkTransforms field
 * which is stored as JSON text in SQLite and parsed back to the ForkTransforms type.
 */
describe('forkTransforms storage', () => {
  useDrizzleTestLifecycle();

  it('should persist and retrieve forkTransforms as JSON', async () => {
    const session = createSession({
      sessionId: 'fork-transforms-test',
      forkTransforms: {
        removedMessageIds: ['msg-1'],
        appliedPipeline: [{ actionId: 'strip-tool-outputs' }],
      },
    });

    const setResult = await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });
    expect(setResult.success).toBe(true);

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });

    expect(retrieved.session).not.toBeNull();
    expect(retrieved.session?.forkTransforms).toEqual({
      removedMessageIds: ['msg-1'],
      appliedPipeline: [{ actionId: 'strip-tool-outputs' }],
    });
  });

  it('should handle undefined forkTransforms', async () => {
    const session = createSession({
      sessionId: 'no-fork-transforms-test',
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });

    expect(retrieved.session?.forkTransforms).toBeUndefined();
  });

  it('should persist and retrieve forkTransforms with segments array', async () => {
    const session = createSession({
      sessionId: 'fork-transforms-segments-test',
      forkTransforms: {
        segments: [
          {
            fromMessageId: 'msg-1',
            toMessageId: 'msg-5',
            policy: 'verbatim',
            stripReasoning: true,
            overrides: { 'msg-3': 'exclude' },
          },
          {
            fromMessageId: 'msg-6',
            toMessageId: 'msg-10',
            policy: 'summarize',
            summaryText: 'Summary of the second segment.',
          },
        ],
      },
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });

    expect(retrieved.session?.forkTransforms).toEqual({
      segments: [
        {
          fromMessageId: 'msg-1',
          toMessageId: 'msg-5',
          policy: 'verbatim',
          stripReasoning: true,
          overrides: { 'msg-3': 'exclude' },
        },
        {
          fromMessageId: 'msg-6',
          toMessageId: 'msg-10',
          policy: 'summarize',
          summaryText: 'Summary of the second segment.',
        },
      ],
    });
  });

  it('should preserve forkTransforms with pipeline options', async () => {
    const session = createSession({
      sessionId: 'fork-transforms-options-test',
      forkTransforms: {
        removedMessageIds: ['msg-a', 'msg-b'],
        appliedPipeline: [
          { actionId: 'strip-tool-outputs', options: { keepErrors: true } },
          { actionId: 'summarize', options: { maxTokens: 500 } },
        ],
      },
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });

    expect(retrieved.session?.forkTransforms).toEqual({
      removedMessageIds: ['msg-a', 'msg-b'],
      appliedPipeline: [
        { actionId: 'strip-tool-outputs', options: { keepErrors: true } },
        { actionId: 'summarize', options: { maxTokens: 500 } },
      ],
    });
  });
});
