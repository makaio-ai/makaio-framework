/**
 * Tests for native locality verdict integration in assembleForkContext.
 *
 * Verifies that native forks produce a fork directive instead of message history,
 * and that non-native forks inject history and attach the locality verdict.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type IMakaioSession } from '@makaio/contracts';
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

describe('assembleForkContext - native locality', () => {
  const cleanup = createCleanupTracker();
  const localMachine = 'local-machine';
  const remoteMachine = 'remote-machine';
  const sourceAdapterSessionId = 'source-native';
  const nativeForkCapabilities = {
    adapterSupportsNativeFork: true,
    midHistoryForkSupported: true,
  };

  beforeEach(() => {
    setupContextTest();
  });

  afterEach(() => {
    cleanup.runAll();
  });

  /**
   * Sets up a fork scenario with a parent message and an empty fork session.
   * @param forkOverrides - Additional fields to set on the fork session
   * @param sourceOverrides - Additional fields to set on the source session
   * @returns The fork session object
   */
  function setupNativeForkScenario(
    forkOverrides: Partial<IMakaioSession> = {},
    sourceOverrides: Partial<IMakaioSession> = {},
  ): IMakaioSession {
    const sourceSession: Partial<IMakaioSession> & { sessionId: string } = {
      sessionId: 'parent',
      parentSessionId: undefined,
      adapterSessionId: sourceAdapterSessionId,
      machineId: localMachine,
      targetWorkingDirectory: '/workspace/source',
      ...sourceOverrides,
    };
    mockGetSession(cleanup, sourceSession);
    cleanup.add(
      MakaioBus.on(
        SessionSubjects.get,
        (ctx) => {
          ctx.setResult({
            session: {
              ...sourceSession,
              createdAt: sourceSession.createdAt ?? Date.now(),
              lastActivityAt: sourceSession.lastActivityAt ?? Date.now(),
              status: sourceSession.status ?? 'active',
              agents: sourceSession.agents ?? [],
            } as IMakaioSession,
          });
        },
        { filter: { sessionId: 'parent' } },
      ),
    );
    const parentMsg = {
      ...createMessage('parent-msg', 'user', 'Hello from parent', {
        sessionId: 'parent',
        timestamp: 1000,
      }),
      adapterMessageId: 'provider-msg-checkpoint',
    };
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
      ...forkOverrides,
    };

    mockGetSession(cleanup, forkSession);
    mockGetEvents(cleanup, forkSession.sessionId, []);
    mockGetTurnsBySession(cleanup, forkSession.sessionId, []);

    return forkSession;
  }

  describe('eligible native fork', () => {
    it('uses the parent provider session for nativeFork even when the child has no native identity yet', async () => {
      const forkSession = setupNativeForkScenario();

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'native' });
      expect(result?.nativeFork).toMatchObject({
        sourceSessionId: 'parent',
        sourceAdapterSessionId: sourceAdapterSessionId,
        forkPointMessageId: 'provider-msg-checkpoint',
      });
      expect(result?.messageHistory).toBeUndefined();
    });

    it('sets isFirstTurn on native fork result', async () => {
      const forkSession = setupNativeForkScenario();

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.isFirstTurn).toBe(true);
    });

    it('degrades when original context reports compression', async () => {
      const forkSession = setupNativeForkScenario();

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        { hasCompression: true },
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.hasCompression).toBe(true);
      expect(result?.nativeLocality).toEqual({ kind: 'degrade', reason: 'compression-present' });
      expect(result?.messageHistory).toHaveLength(1);
      expect(result?.nativeFork).toBeUndefined();
    });

    it('includes targetWorkingDirectory in nativeFork when it matches the source cwd', async () => {
      const forkSession = setupNativeForkScenario({
        targetWorkingDirectory: '/workspace/source',
      });

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeFork?.targetWorkingDirectory).toBe('/workspace/source');
    });

    it('injects messageHistory when the fork target cwd differs from the source cwd', async () => {
      const forkSession = setupNativeForkScenario({
        targetWorkingDirectory: '/workspace/child',
      });

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'degrade', reason: 'cwd-mismatch' });
      expect(result?.messageHistory).toHaveLength(1);
      expect(result?.nativeFork).toBeUndefined();
    });
  });

  describe('source resume currency', () => {
    it('branches from the confirmed currency instead of the origin identity', async () => {
      const forkSession = setupNativeForkScenario(
        {},
        {
          currentAdapterSessionId: 'rotated-native',
          currentAdapterSessionIdState: 'confirmed',
        },
      );

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'native' });
      expect(result?.nativeFork?.sourceAdapterSessionId).toBe('rotated-native');
    });

    it('degrades when the source provider session moved without confirmation', async () => {
      const forkSession = setupNativeForkScenario({}, { currentAdapterSessionIdState: 'moved' });

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'degrade', reason: 'adapter-session-moved' });
      expect(result?.nativeFork).toBeUndefined();
      expect(result?.messageHistory).toHaveLength(1);
    });
  });

  describe('mid-history fork adapter message resolution', () => {
    it('resolves adapterMessageId from the fork-point message for the directive', async () => {
      // Default scenario: parent-msg has adapterMessageId: 'provider-msg-checkpoint'
      const forkSession = setupNativeForkScenario();

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'native' });
      expect(result?.nativeFork).toMatchObject({
        sourceSessionId: 'parent',
        sourceAdapterSessionId,
        forkPointMessageId: 'provider-msg-checkpoint',
      });
      expect(result?.messageHistory).toBeUndefined();
    });

    it('degrades to fresh-with-history when the fork-point message lacks adapterMessageId', async () => {
      // Override the parent message to have no adapterMessageId — simulates
      // a locally-created assistant message where SessionBridge stamped a fresh UUID.
      const parentMsgNoAdapter = createMessage('parent-msg-no-adapter', 'assistant', 'Response', {
        sessionId: 'parent',
        timestamp: 1000,
      });
      // Wire up message mock for the no-adapter message and events for getFullConversation
      const forkSession = setupNativeForkScenario({
        forkPointMessageId: 'parent-msg-no-adapter',
      });
      // Register the mock for the message without adapterMessageId
      mockGetMessage(cleanup, 'parent-msg-no-adapter', parentMsgNoAdapter);
      // getFullConversation traverses the fork session, which has events from parent
      mockGetEvents(cleanup, 'fork', [
        messageEvent('parent-msg-no-adapter', 1000, { sessionId: 'parent', role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'parent-msg-no-adapter', parentMsgNoAdapter);

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'degrade', reason: 'fork-point-unresolvable' });
      expect(result?.nativeFork).toBeUndefined();
      expect(result?.messageHistory).toBeDefined();
      expect(result?.isFirstTurn).toBe(true);
    });

    it('does not set forkPointMessageId on the directive for fork-at-head (no fromMessageId)', async () => {
      // Fork-at-head: no forkPointMessageId on the session
      const forkSession = setupNativeForkScenario({
        forkPointMessageId: undefined,
      });

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'native' });
      expect(result?.nativeFork).toBeDefined();
      expect(result?.nativeFork?.forkPointMessageId).toBeUndefined();
      expect(result?.nativeFork?.sourceAdapterSessionId).toBe(sourceAdapterSessionId);
      expect(result?.messageHistory).toBeUndefined();
    });
  });

  describe('transform fallback (non-native)', () => {
    it('injects messageHistory and attaches degrade verdict when transforms are present', async () => {
      const forkSession = setupNativeForkScenario({
        forkTransforms: { removedMessageIds: ['some-msg'] },
      });

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'degrade', reason: 'transforms-present' });
      expect(result?.messageHistory).toHaveLength(1);
      expect(result?.nativeFork).toBeUndefined();
    });
  });

  describe('foreign machine fallback', () => {
    it('injects messageHistory and attaches foreign verdict when the source machineId differs', async () => {
      const forkSession = setupNativeForkScenario({}, { machineId: remoteMachine });

      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'foreign', machineId: remoteMachine });
      expect(result?.messageHistory).toHaveLength(1);
      expect(result?.nativeFork).toBeUndefined();
    });
  });

  describe('no localMachineId supplied', () => {
    it('degrades with missing-machine-id when localMachineId is undefined', async () => {
      const forkSession = setupNativeForkScenario();

      // Pass no localMachineId — evaluator cannot confirm identity.
      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        undefined,
        true,
        undefined,
        nativeForkCapabilities,
      );

      expect(result?.nativeLocality).toEqual({ kind: 'degrade', reason: 'missing-machine-id' });
      expect(result?.messageHistory).toHaveLength(1);
    });
  });

  describe('non-fork first-turn guard', () => {
    it('returns originalContext unchanged when isNewTurn is false', async () => {
      const forkSession = setupNativeForkScenario();
      // Override turns so it looks like a subsequent turn.
      mockGetTurnsBySession(cleanup, 'fork', [
        { turnId: 't1', sessionId: 'fork', turnNumber: 1, startedAt: Date.now(), status: 'completed' },
      ]);

      const originalContext = {};
      const result = await assembleForkContext(
        MakaioBus,
        forkSession,
        'fork',
        originalContext,
        false,
        localMachine,
        nativeForkCapabilities,
      );

      expect(result).toBe(originalContext);
    });
  });
});
