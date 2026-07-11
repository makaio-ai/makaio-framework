/**
 * Tests for native-attempt-failed degrade behaviour in routeToAgents.
 *
 * When the outbound SessionContext carries `nativeLocality.kind === 'native'`
 * and the adapter rejects the request, routeToAgents must:
 * 1. Catch the error on the first attempt.
 * 2. Rebuild history from storage.
 * 3. Retry once with a degraded context (kind: 'degrade', reason: 'native-attempt-failed').
 * 4. Treat the retry outcome as the turn result.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession } from '@makaio/contracts';
import { HookAbortError } from '@makaio/hooks';
import { Turn } from '../../entities/turn.js';
import {
  createRouteTestContext,
  ROUTE_TEST_IDS,
  routeToAgentsWithTestLedger as routeToAgents,
  type RouteTestContext,
} from './shared.js';
import { createTestAgent, createTestSession } from '../../__tests__/shared.js';
import {
  mockGetSession,
  mockGetEvents,
  mockGetMessage,
  mockGetTurnsBySession,
  createMessage,
  messageEvent,
  createCleanupTracker,
} from '../../context/__tests__/test-helpers.js';

describe('routeToAgents - native attempt degrade', () => {
  const { sessionId, messageId, turnId, testMessage } = ROUTE_TEST_IDS;
  let ctx: RouteTestContext;
  const storageCleanup = createCleanupTracker();

  beforeEach(() => {
    ctx = createRouteTestContext();
    // Mock storage so getFullConversation can traverse the session chain.
    // The session has no parent so the chain is just [sessionId], and has no
    // messages so the rebuilt messageHistory is empty (sufficient for this test).
    mockGetSession(storageCleanup, { sessionId, parentSessionId: undefined });
    mockGetEvents(storageCleanup, sessionId, []);
  });

  afterEach(() => {
    ctx.destroy();
    storageCleanup.runAll();
    vi.restoreAllMocks();
  });

  it('retries with history injection when native attempt fails', async () => {
    let nativeAttemptCount = 0;
    let freshHistoryAttemptCount = 0;
    // Captured from the second (degrade) attempt's sessionContext payload.
    let capturedRetryNativeLocality: unknown;
    let capturedRetryMessageHistory: unknown;
    let capturedRetryIsFirstTurn: unknown;
    let capturedRetryNativeFork: unknown;

    const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
      const sc = context.payload.sessionContext;
      if (sc?.nativeLocality?.kind === 'native') {
        nativeAttemptCount += 1;
        throw new Error('Provider rejected native resume');
      }
      // Second attempt — fresh-with-history path.
      freshHistoryAttemptCount += 1;
      capturedRetryNativeLocality = sc?.nativeLocality;
      capturedRetryMessageHistory = sc?.messageHistory;
      capturedRetryIsFirstTurn = sc?.isFirstTurn;
      capturedRetryNativeFork = sc?.nativeFork;
      context.setResult({ messageId: context.payload.messageId ?? 'retry-id' });
    });
    ctx.trackUnsubscribe(unsub);

    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);

    // Supply a native locality verdict so routeToAgents routes natively.
    const nativeSessionContext = { nativeLocality: { kind: 'native' as const } };

    await routeToAgents({
      bus: MakaioBus,
      session,
      agents: [agent],
      message: testMessage,
      messageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete,
      sessionContext: nativeSessionContext,
    });

    expect(nativeAttemptCount).toBe(1);
    expect(freshHistoryAttemptCount).toBe(1);
    expect(capturedRetryNativeLocality).toEqual({
      kind: 'degrade',
      reason: 'native-attempt-failed',
    });
    expect(capturedRetryMessageHistory).toBeDefined();
    expect(capturedRetryIsFirstTurn).toBe(true);
    expect(capturedRetryNativeFork).toBeUndefined();
  });

  it('excludes the persisted current user message from native retry history', async () => {
    const retrySessionId = 'session-with-current-message';
    const retryMessageId = 'current-message';
    const priorMessageId = 'prior-message';
    mockGetSession(storageCleanup, { sessionId: retrySessionId, parentSessionId: undefined });
    mockGetEvents(storageCleanup, retrySessionId, [
      messageEvent(priorMessageId, 1000, { sessionId: retrySessionId, role: 'user' }),
      messageEvent(retryMessageId, 2000, { sessionId: retrySessionId, role: 'user' }),
    ]);
    mockGetMessage(
      storageCleanup,
      priorMessageId,
      createMessage(priorMessageId, 'user', 'already persisted before this turn', {
        sessionId: retrySessionId,
        timestamp: 1000,
      }),
    );
    mockGetMessage(
      storageCleanup,
      retryMessageId,
      createMessage(retryMessageId, 'user', 'current persisted message', {
        sessionId: retrySessionId,
        timestamp: 2000,
      }),
    );

    let capturedRetryMessageHistory: unknown;
    const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
      const sc = context.payload.sessionContext;
      if (sc?.nativeLocality?.kind === 'native') {
        throw new Error('Provider rejected native resume');
      }
      capturedRetryMessageHistory = sc?.messageHistory;
      context.setResult({ messageId: context.payload.messageId ?? 'retry-id' });
    });
    ctx.trackUnsubscribe(unsub);

    const agent = createTestAgent('agent-1', { sessionId: retrySessionId });
    const session = createTestSession(retrySessionId, { agents: [agent] });
    const turn = new Turn({ sessionId: retrySessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });

    await routeToAgents({
      bus: MakaioBus,
      session,
      agents: [agent],
      message: testMessage,
      messageId: retryMessageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete: vi.fn(),
      sessionContext: { nativeLocality: { kind: 'native' } },
    });

    expect(capturedRetryMessageHistory).toEqual([
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'already persisted before this turn' }],
      },
    ]);
  });

  it('does not degrade or retry when native attempt is cancelled by a hook', async () => {
    let sendCount = 0;
    const completedOutcomes: string[] = [];
    const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
      sendCount += 1;
      if (context.payload.sessionContext?.nativeLocality?.kind === 'native') {
        throw new HookAbortError('policy-check', 'cancel requested');
      }
      context.setResult({ messageId: context.payload.messageId ?? 'unexpected-retry' });
    });
    ctx.trackUnsubscribe(unsub);
    ctx.trackUnsubscribe(
      MakaioBus.on(SessionSubjects.user_message.completed, ({ payload }) => {
        completedOutcomes.push(payload.outcome);
      }),
    );

    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);

    await routeToAgents({
      bus: MakaioBus,
      session,
      agents: [agent],
      message: testMessage,
      messageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete,
      sessionContext: { nativeLocality: { kind: 'native' } },
    });

    expect(sendCount).toBe(1);
    expect(completedOutcomes).toEqual(['cancelled']);
    expect(turn.getResult().success).toBe(true);
    expect(onTurnComplete).toHaveBeenCalledWith(turn, expect.objectContaining({ success: true }));
  });

  it('marks agent as errored when both native attempt and retry fail', async () => {
    const unsub = MakaioBus.on(AgentSubjects.sendMessage, () => {
      throw new Error('Provider unavailable');
    });
    ctx.trackUnsubscribe(unsub);

    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);

    await routeToAgents({
      bus: MakaioBus,
      session,
      agents: [agent],
      message: testMessage,
      messageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete,
      sessionContext: { nativeLocality: { kind: 'native' as const } },
    });

    expect(turn.getResult().success).toBe(false);
    expect(onTurnComplete).toHaveBeenCalledWith(turn, expect.objectContaining({ success: false }));
  });

  it('does not retry when non-native context fails', async () => {
    let sendCount = 0;
    const unsub = MakaioBus.on(AgentSubjects.sendMessage, () => {
      sendCount += 1;
      throw new Error('Agent unreachable');
    });
    ctx.trackUnsubscribe(unsub);

    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);

    // No nativeLocality in context — should not trigger retry.
    const plainSessionContext = { messageHistory: [] as [] };

    await routeToAgents({
      bus: MakaioBus,
      session,
      agents: [agent],
      message: testMessage,
      messageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete,
      sessionContext: plainSessionContext,
    });

    // Only one attempt — no retry for non-native context.
    expect(sendCount).toBe(1);
    expect(turn.getResult().success).toBe(false);
  });

  it('does not fallback when ack listener rejects after successful native send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let sendMessageCount = 0;
    const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
      sendMessageCount += 1;
      context.setResult({ messageId: context.payload.messageId ?? 'native-ok' });
    });
    ctx.trackUnsubscribe(unsub);

    // Acknowledgement listener that throws after the send already succeeded.
    const unsubAck = MakaioBus.on(SessionSubjects.user_message.acknowledged, () => {
      throw new Error('Ack listener blew up');
    });
    ctx.trackUnsubscribe(unsubAck);

    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);

    await routeToAgents({
      bus: MakaioBus,
      session,
      agents: [agent],
      message: testMessage,
      messageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete,
      sessionContext: { nativeLocality: { kind: 'native' } },
    });

    // The message must be sent exactly once — the ack failure must NOT
    // trigger a fallback resend.
    expect(sendMessageCount).toBe(1);
    // Observation failure cannot roll back an accepted provider turn.
    expect(turn.isComplete()).toBe(false);
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[SessionRouting] Failed to emit user-message acknowledgement:',
      expect.any(Error),
    );
  });

  it('still falls back exactly once on a genuine send failure', async () => {
    let sendMessageCount = 0;
    let capturedRetryNativeLocality: unknown;
    const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
      sendMessageCount += 1;
      const sc = context.payload.sessionContext;
      if (sc?.nativeLocality?.kind === 'native') {
        throw new Error('Provider rejected native resume');
      }
      // Second attempt — degrade path.
      capturedRetryNativeLocality = sc?.nativeLocality;
      context.setResult({ messageId: context.payload.messageId ?? 'retry-id' });
    });
    ctx.trackUnsubscribe(unsub);

    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);

    await routeToAgents({
      bus: MakaioBus,
      session,
      agents: [agent],
      message: testMessage,
      messageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete,
      sessionContext: { nativeLocality: { kind: 'native' } },
    });

    // Native attempt + one fallback retry = 2 sends total.
    expect(sendMessageCount).toBe(2);
    expect(capturedRetryNativeLocality).toEqual({
      kind: 'degrade',
      reason: 'native-attempt-failed',
    });
    expect(turn.isComplete()).toBe(false);
  });

  it('emits user_message.acknowledged after successful retry', async () => {
    const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
      const sc = context.payload.sessionContext;
      if (sc?.nativeLocality?.kind === 'native') {
        throw new Error('Provider rejected native resume');
      }
      context.setResult({ messageId: context.payload.messageId ?? 'retry-id' });
    });
    ctx.trackUnsubscribe(unsub);

    const acknowledgedAgentIds: string[] = [];
    const unsubAck = MakaioBus.on(SessionSubjects.user_message.acknowledged, ({ payload }) => {
      acknowledgedAgentIds.push(payload.agentId);
    });
    ctx.trackUnsubscribe(unsubAck);

    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);

    await routeToAgents({
      bus: MakaioBus,
      session,
      agents: [agent],
      message: testMessage,
      messageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete,
      sessionContext: { nativeLocality: { kind: 'native' } },
    });

    expect(acknowledgedAgentIds).toContain('agent-1');
    expect(turn.isComplete()).toBe(false);
  });
});

describe('routeToAgents - fork-one-shot degrade for sendMessage path', () => {
  /**
   * Regression test for the fork-one-shot invariant: a nativeFork directive
   * is only consumable on the startAgent path. When routeToAgents dispatches
   * to already-running idle agents via sendMessage, the native fork directive
   * would silently vanish — the child starts with empty context. routeToAgents
   * must detect this and degrade to fresh-with-history, injecting the projected
   * parent conversation.
   */
  const parentSessionId = 'parent-session';
  const forkSessionId = 'fork-session';
  const parentMsgId = 'parent-msg-1';
  const localMachineId = 'local-machine';
  const sourceAdapterSessionId = 'source-adapter-session';
  const messageId = 'fork-msg-001';
  const turnId = 'fork-turn-001';

  let ctx: RouteTestContext;
  const storageCleanup = createCleanupTracker();

  beforeEach(() => {
    ctx = createRouteTestContext();

    // Parent session: has adapter session, same machine — eligible for native fork.
    mockGetSession(storageCleanup, {
      sessionId: parentSessionId,
      parentSessionId: undefined,
      adapterSessionId: sourceAdapterSessionId,
      machineId: localMachineId,
      targetWorkingDirectory: '/workspace',
    });

    // Parent session also available via SessionSubjects.get (for assembleForkContext).
    storageCleanup.add(
      MakaioBus.on(
        SessionSubjects.get,
        (busCtx) => {
          busCtx.setResult({
            session: {
              sessionId: parentSessionId,
              parentSessionId: undefined,
              adapterSessionId: sourceAdapterSessionId,
              machineId: localMachineId,
              targetWorkingDirectory: '/workspace',
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              status: 'active',
              agents: [],
            } as IMakaioSession,
          });
        },
        { filter: { sessionId: parentSessionId } },
      ),
    );

    // Parent has one user message in history.
    mockGetEvents(storageCleanup, parentSessionId, [
      messageEvent(parentMsgId, 1000, { sessionId: parentSessionId, role: 'user' }),
    ]);
    mockGetMessage(
      storageCleanup,
      parentMsgId,
      createMessage(parentMsgId, 'user', 'Hello from parent', {
        sessionId: parentSessionId,
        timestamp: 1000,
        // Provider-native ID so the mid-history fork point resolves and this
        // suite exercises the agent-already-started degrade, not
        // fork-point-unresolvable.
        adapterMessageId: 'adapter-msg-parent',
      }),
    );

    // Fork session: first turn, no messages yet.
    mockGetSession(storageCleanup, {
      sessionId: forkSessionId,
      parentSessionId,
      forkPointMessageId: parentMsgId,
    });
    mockGetEvents(storageCleanup, forkSessionId, []);
    mockGetTurnsBySession(storageCleanup, forkSessionId, []);

    // Adapter declares native fork support.
    storageCleanup.add(
      MakaioBus.on(AdapterSubjects.getCapabilities, (busCtx) => {
        busCtx.setResult({
          capabilities: ['session:fork', 'session:forkAtMessage'],
          nativeTools: [],
        });
      }),
    );
  });

  afterEach(() => {
    ctx.destroy();
    storageCleanup.runAll();
  });

  it('degrades nativeFork to fresh-with-history when routing to an already-running agent', async () => {
    // Captured as individual fields (file convention): the whole-object
    // assignment trips TS2719 because bus payload types flow through bundled
    // d.ts and are nominally unrelated to the source SessionContext.
    let capturedNativeFork: unknown;
    let capturedNativeLocality: unknown;
    let capturedMessageHistory: unknown[] | undefined;
    let capturedIsFirstTurn: unknown;

    const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
      const sc = context.payload.sessionContext;
      capturedNativeFork = sc?.nativeFork;
      capturedNativeLocality = sc?.nativeLocality;
      capturedMessageHistory = sc?.messageHistory;
      capturedIsFirstTurn = sc?.isFirstTurn;
      context.setResult({ messageId: context.payload.messageId ?? 'ack-id' });
    });
    ctx.trackUnsubscribe(unsub);

    const agent = createTestAgent('agent-1', { sessionId: forkSessionId, status: 'idle' });
    const forkSession = createTestSession(forkSessionId, {
      agents: [agent],
      parentSessionId,
      forkPointMessageId: parentMsgId,
    });
    const turn = new Turn({ sessionId: forkSessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });

    await routeToAgents({
      bus: MakaioBus,
      session: forkSession,
      agents: [agent],
      message: 'Continue the conversation',
      messageId,
      turn,
      deliveryMode: undefined,
      onTurnComplete: vi.fn().mockResolvedValue(undefined),
      isNewTurn: true,
      localMachineId,
    });

    // The nativeFork directive must NOT reach the agent — it can only be
    // consumed on the startAgent path, not sendMessage.
    expect(capturedNativeFork).toBeUndefined();

    // Instead, the agent receives degraded context with projected parent history.
    expect(capturedNativeLocality).toEqual({
      kind: 'degrade',
      reason: 'agent-already-started',
    });
    expect(capturedMessageHistory).toBeDefined();
    expect(capturedMessageHistory!.length).toBeGreaterThan(0);
    expect(capturedIsFirstTurn).toBe(true);
  });
});
