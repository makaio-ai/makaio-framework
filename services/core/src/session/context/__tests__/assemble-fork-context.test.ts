import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { SessionMessage, IMakaioSession, SessionContext } from '@makaio/contracts';
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

describe('assembleForkContext', () => {
  const cleanup = createCleanupTracker();

  beforeEach(() => {
    setupContextTest();
  });

  afterEach(() => {
    cleanup.runAll();
  });

  describe('non-fork sessions', () => {
    it('should return original context for sessions without parentSessionId', async () => {
      const session: IMakaioSession = {
        sessionId: 'session-1',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'active',
        agents: [],
        // No parentSessionId
      };

      const originalContext: SessionContext = {};

      const result = await assembleForkContext(MakaioBus, session, 'session-1', originalContext);

      expect(result).toBe(originalContext); // Same reference, unchanged
    });

    it('should return original context when parent-history has no parent session', async () => {
      const session: IMakaioSession = {
        sessionId: 'session-1',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'active',
        agents: [],
        contextInheritance: 'parent-history',
      };

      const originalContext: SessionContext = {};

      const result = await assembleForkContext(MakaioBus, session, 'session-1', originalContext, true);

      expect(result).toBe(originalContext);
    });

    it('should return original context if messageHistory already exists', async () => {
      const session: IMakaioSession = {
        sessionId: 'session-1',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'active',
        agents: [],
        parentSessionId: 'parent-1', // Has parent
      };

      const originalContext: SessionContext = {
        messageHistory: [{ role: 'user', blocks: [{ type: 'text', content: 'existing' }] }],
      };

      const result = await assembleForkContext(MakaioBus, session, 'session-1', originalContext);

      expect(result).toBe(originalContext); // Same reference, unchanged
    });
  });

  describe('fork sessions first turn', () => {
    /**
     * Sets up parent session with a single message and a fork session with no turns.
     * @param forkOverrides - Additional fields to set on the fork session
     * @returns The fork session object
     */
    function setupFirstTurnFork(forkOverrides: Partial<IMakaioSession> = {}): IMakaioSession {
      mockGetSession(cleanup, { sessionId: 'parent', parentSessionId: undefined });
      const parentMsg = createMessage('parent-msg', 'user', 'Hello from parent', {
        sessionId: 'parent',
        timestamp: 1000,
      });
      mockGetEvents(cleanup, 'parent', [messageEvent('parent-msg', 1000, { sessionId: 'parent', role: 'user' })]);
      mockGetMessage(cleanup, 'parent-msg', parentMsg);

      const forkSessionId = (forkOverrides.sessionId as string) ?? 'fork';
      const forkSession: IMakaioSession = {
        sessionId: forkSessionId,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'active',
        agents: [],
        parentSessionId: 'parent',
        forkPointMessageId: 'parent-msg',
        ...forkOverrides,
      };

      mockGetSession(cleanup, forkSession);
      mockGetEvents(cleanup, forkSessionId, []);
      mockGetTurnsBySession(cleanup, forkSessionId, []);

      return forkSession;
    }

    it('should assemble context for fork session with no turns', async () => {
      const forkSession = setupFirstTurnFork({ sessionId: 'child' });

      const result = await assembleForkContext(MakaioBus, forkSession, 'child', undefined, true);

      expect(result).not.toBeUndefined();
      expect(result?.messageHistory).toHaveLength(1);
      expect(result?.isFirstTurn).toBe(true);
      expect(result?.hasNewTransforms).toBe(false);
    });

    it('should set hasNewTransforms when forkTransforms defined', async () => {
      const forkSession = setupFirstTurnFork({
        forkTransforms: { removedMessageIds: [] },
      });

      const result = await assembleForkContext(MakaioBus, forkSession, 'fork', undefined, true);

      expect(result?.hasNewTransforms).toBe(true);
    });

    it('should preserve original context fields', async () => {
      const forkSession = setupFirstTurnFork();

      const originalContext: SessionContext = {
        hasCompression: true,
      };

      const result = await assembleForkContext(MakaioBus, forkSession, 'fork', originalContext, true);

      expect(result?.hasCompression).toBe(true);
      expect(result?.messageHistory).toBeDefined();
    });

    it('should skip fork context when isNewTurn is not provided', async () => {
      const forkSession = setupFirstTurnFork();

      const originalContext: SessionContext = {};

      const result = await assembleForkContext(MakaioBus, forkSession, 'fork', originalContext);

      expect(result).toBe(originalContext);
    });

    it('does not assemble parent history when contextInheritance is none', async () => {
      const forkSession = setupFirstTurnFork({
        sessionId: 'child',
        branchKind: 'subagent',
        contextInheritance: 'none',
      });

      const result = await assembleForkContext(MakaioBus, forkSession, 'child', undefined, true);

      expect(result).toBeUndefined();
    });

    it('assembles parent history when contextInheritance is parent-history', async () => {
      const forkSession = setupFirstTurnFork({
        sessionId: 'child',
        branchKind: 'subagent',
        contextInheritance: 'parent-history',
      });

      const result = await assembleForkContext(MakaioBus, forkSession, 'child', undefined, true);

      expect(result?.messageHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
          }),
        ]),
      );
    });
  });

  describe('fork sessions subsequent turns', () => {
    it('should return original context if session already has turns', async () => {
      // Fork session that already has a turn
      const forkSession: IMakaioSession = {
        sessionId: 'fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'active',
        agents: [],
        parentSessionId: 'parent',
        forkPointMessageId: 'parent-msg',
      };

      mockGetTurnsBySession(cleanup, 'fork', [
        { turnId: 'existing-turn', sessionId: 'fork', turnNumber: 1, startedAt: Date.now(), status: 'completed' },
      ]); // Has existing turn

      const originalContext: SessionContext = {};

      // isNewTurn=false because this is a subsequent turn (turn already exists in production)
      const result = await assembleForkContext(MakaioBus, forkSession, 'fork', originalContext, false);

      expect(result).toBe(originalContext); // Unchanged — not a new turn
    });
  });

  describe('message conversion', () => {
    it('should convert SessionMessage blocks to Message blocks', async () => {
      // Parent session with various block types
      mockGetSession(cleanup, { sessionId: 'parent', parentSessionId: undefined });

      const parentMsgWithBlocks: SessionMessage = {
        messageId: 'msg-1',
        sessionId: 'parent',
        turnId: 'turn-1',
        role: 'assistant',
        contentText: 'Tool response',
        blocks: [
          { type: 'text', content: 'Running command...' },
          { type: 'tool_call', toolCallId: 'tool-1', name: 'bash', args: { cmd: 'ls' } },
          { type: 'tool_output', toolCallId: 'tool-1', output: 'file.txt' },
        ],
        timestamp: 1000,
      };

      mockGetEvents(cleanup, 'parent', [messageEvent('msg-1', 1000, { sessionId: 'parent', role: 'assistant' })]);
      mockGetMessage(cleanup, 'msg-1', parentMsgWithBlocks);

      // Fork session
      const forkSession: IMakaioSession = {
        sessionId: 'fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'active',
        agents: [],
        parentSessionId: 'parent',
        forkPointMessageId: 'msg-1',
      };

      mockGetSession(cleanup, forkSession);
      mockGetEvents(cleanup, 'fork', []);
      mockGetTurnsBySession(cleanup, 'fork', []);

      const result = await assembleForkContext(MakaioBus, forkSession, 'fork', undefined, true);

      expect(result?.messageHistory).toHaveLength(1);
      const convertedMsg = result?.messageHistory?.[0];
      expect(convertedMsg?.role).toBe('assistant');
      // Blocks pass through with their original types (no conversion)
      const blocks = Array.isArray(convertedMsg?.blocks) ? convertedMsg.blocks : [convertedMsg?.blocks];
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toMatchObject({ type: 'text', content: 'Running command...' });
      expect(blocks[1]).toMatchObject({ type: 'tool_call', name: 'bash' });
      expect(blocks[2]).toMatchObject({ type: 'tool_output', output: 'file.txt' });
    });
  });
});
