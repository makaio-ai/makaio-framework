/**
 * Tests for context field preservation in assembleForkContext.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { IMakaioSession, SessionContext } from '@makaio/contracts';
import { assembleForkContext } from '../assemble-fork-context.js';
import {
  createCleanupTracker,
  setupContextTest,
  mockGetSession,
  mockGetEvents,
  mockGetMessage,
  mockGetTurnsBySession,
  createMessage,
  messageEvent,
} from './test-helpers.js';

describe('assembleForkContext - context field preservation', () => {
  const cleanup = createCleanupTracker();

  beforeEach(() => {
    setupContextTest();
  });

  afterEach(() => {
    cleanup.runAll();
  });

  /**
   * Sets up parent and fork session mocks with a single parent message.
   * @returns The fork session object
   */
  function setupForkFromParent(): IMakaioSession {
    mockGetSession(cleanup, { sessionId: 'parent', parentSessionId: undefined });
    const parentMsg = createMessage('parent-msg', 'user', 'Parent content', {
      sessionId: 'parent',
      timestamp: 1000,
    });
    mockGetEvents(cleanup, 'parent', [messageEvent('parent-msg', 1000, { sessionId: 'parent', role: 'user' })]);
    mockGetMessage(cleanup, 'parent-msg', parentMsg);

    const forkSession: IMakaioSession = {
      sessionId: 'fork',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'active',
      agents: [],
      parentSessionId: 'parent',
      forkPointMessageId: 'parent-msg',
    };

    mockGetSession(cleanup, forkSession);
    mockGetEvents(cleanup, 'fork', []);
    mockGetTurnsBySession(cleanup, 'fork', []);

    return forkSession;
  }

  it('should preserve hasCompression from originalContext through spread', async () => {
    const forkSession = setupForkFromParent();

    const originalContext: SessionContext = {
      hasCompression: true,
    };

    const result = await assembleForkContext(MakaioBus, forkSession, 'fork', originalContext, true);

    expect(result).not.toBeUndefined();
    expect(result?.hasCompression).toBe(true);
    expect(result?.messageHistory).toHaveLength(1);
    expect(result?.isFirstTurn).toBe(true);
  });

  it('should preserve additional context fields when originalContext has them', async () => {
    const forkSession = setupForkFromParent();

    const originalContext: SessionContext = {
      hasCompression: true,
      hasNewTransforms: true,
      turnContext: {
        lockWarning: {
          message: 'locked',
        },
      },
    };

    const result = await assembleForkContext(MakaioBus, forkSession, 'fork', originalContext, true);

    expect(result).not.toBeUndefined();
    expect(result?.hasCompression).toBe(true);
    expect(result?.hasNewTransforms).toBe(false);
    expect(result?.turnContext).toEqual({
      lockWarning: {
        message: 'locked',
      },
    });
  });
});
