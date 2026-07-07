/**
 * Tests for native locality verdict integration in the attach handler.
 *
 * Verifies that `resolveAttachLocality` gates native resume mode by adapter
 * capability declaration and machine identity, and forwards the locality
 * verdict to non-native paths via sessionContext.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { IMakaioSession, MakaioSessionEvent, SessionMessage } from '@makaio/contracts';
import {
  AdapterSubjects,
  MessageStorageSubjects,
  SessionEventStorageSubjects,
  SessionStorageSubjects,
  SessionSubjects,
} from '@makaio/contracts';
import {
  ATTACH_TEST_IDS,
  createAttachHandlerContext,
  type AttachHandlerTestContext,
  type StartAgentRequestPayload,
} from './shared.js';

/**
 * Registers the common mock trio needed by every native-locality test:
 * session.get handler, adapter.startAgent handler, and the attach handler
 * itself. Returns the `receivedRequests` array for startAgent assertions.
 * @param ctx - Attach handler test context
 * @param session - Mock session to return from session.get
 * @param machineId - Machine ID for the attach handler registration
 * @returns Array of captured startAgent request payloads
 */
function setupLocalityTest(
  ctx: AttachHandlerTestContext,
  session: IMakaioSession,
  machineId: string,
): StartAgentRequestPayload[] {
  ctx.trackUnsubscribe(ctx.registerSessionGetHandler(session));
  const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
  ctx.trackUnsubscribe(unsubscribe);
  ctx.trackUnsubscribe(ctx.registerHandler(machineId));
  return receivedRequests;
}

describe('registerAttachHandler - native locality', () => {
  const { sessionId, adapterName } = ATTACH_TEST_IDS;
  const nativeAdapterSessionId = 'native-session';
  const localMachine = 'local-machine';
  const remoteMachine = 'remote-machine';

  let ctx: AttachHandlerTestContext;

  beforeEach(() => {
    ctx = createAttachHandlerContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  describe('when adapter does not declare session:resume', () => {
    it('degrades to adapter-unsupported and starts fresh without resume mode', async () => {
      ctx.setDefaultAdapterCapabilities([]);
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
          isImported: true,
          isOrchestrated: false,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).not.toHaveProperty('mode');
      expect(receivedRequests[0]).not.toHaveProperty('adapterSessionId');
      expect(receivedRequests[0].sessionContext?.nativeLocality).toEqual({
        kind: 'degrade',
        reason: 'adapter-unsupported',
      });
    });
  });

  describe('when session machineId matches local machineId', () => {
    it('sends startAgent with mode: resume and adapterSessionId set', async () => {
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
          isImported: true,
          isOrchestrated: false,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        mode: 'resume',
        adapterSessionId: nativeAdapterSessionId,
      });
    });

    it('does not include sessionContext.nativeLocality when resume is native', async () => {
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
          isImported: true,
          isOrchestrated: false,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests[0]).not.toHaveProperty('sessionContext');
    });

    it('degrades to cwd-mismatch when the attach target cwd differs from the stored session cwd', async () => {
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
          targetWorkingDirectory: '/workspace/old',
          isImported: true,
          isOrchestrated: false,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, cwd: '/workspace/new' },
      });

      expect(receivedRequests[0]).not.toHaveProperty('mode');
      expect(receivedRequests[0]).not.toHaveProperty('adapterSessionId');
      expect(receivedRequests[0].sessionContext?.nativeLocality).toEqual({
        kind: 'degrade',
        reason: 'cwd-mismatch',
      });
    });

    it('resumes natively and carries session cwd when attach omits cwd', async () => {
      const sessionCwd = '/workspace/session-dir';
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
          targetWorkingDirectory: sessionCwd,
          isImported: true,
          isOrchestrated: false,
        }),
        localMachine,
      );

      // Attach without explicit cwd — should default to session.targetWorkingDirectory.
      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        mode: 'resume',
        adapterSessionId: nativeAdapterSessionId,
        cwd: sessionCwd,
      });
    });

    it('degrades to adapter-mismatch when target adapter differs from session adapter', async () => {
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
          adapterName: 'claude-code',
          isImported: true,
          isOrchestrated: false,
        }),
        localMachine,
      );

      // Attach using a different adapter name than the session's stored adapter.
      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'codex-mcp' },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).not.toHaveProperty('mode');
      expect(receivedRequests[0]).not.toHaveProperty('adapterSessionId');
      expect(receivedRequests[0].sessionContext?.nativeLocality).toEqual({
        kind: 'degrade',
        reason: 'adapter-mismatch',
      });
    });
  });

  describe('when session machineId does not match local machineId', () => {
    it('sends startAgent without mode and without adapterSessionId', async () => {
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: remoteMachine,
          adapterSessionId: nativeAdapterSessionId,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests[0]).not.toHaveProperty('mode');
      expect(receivedRequests[0]).not.toHaveProperty('adapterSessionId');
    });

    it('forwards nativeLocality foreign verdict in sessionContext', async () => {
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: remoteMachine,
          adapterSessionId: nativeAdapterSessionId,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests[0].sessionContext?.nativeLocality).toEqual({
        kind: 'foreign',
        machineId: remoteMachine,
      });
    });
  });

  describe('when session has no machineId', () => {
    it('degrades to missing-machine-id and forwards nativeLocality in sessionContext', async () => {
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          adapterSessionId: nativeAdapterSessionId,
          // machineId intentionally absent
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests[0]).not.toHaveProperty('mode');
      expect(receivedRequests[0].sessionContext?.nativeLocality).toEqual({
        kind: 'degrade',
        reason: 'missing-machine-id',
      });
    });
  });

  describe('live-writer guard (agent-already-started)', () => {
    /**
     * Registers a mock adapter.listAgents handler returning the given agents.
     * @param testCtx - Test context for cleanup tracking
     * @param agents - List of live agents to report
     */
    function registerListAgentsHandler(
      testCtx: AttachHandlerTestContext,
      agents: Array<{ agentId: string; sessionId: string; adapterSessionId: string }>,
    ): void {
      testCtx.trackUnsubscribe(
        MakaioBus.on(AdapterSubjects.listAgents, (context) => {
          context.setResult({ agents });
        }),
      );
    }

    it('degrades to agent-already-started when a live agent holds the same adapterSessionId', async () => {
      registerListAgentsHandler(ctx, [
        { agentId: 'existing-agent', sessionId, adapterSessionId: nativeAdapterSessionId },
      ]);
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).not.toHaveProperty('mode');
      expect(receivedRequests[0]).not.toHaveProperty('adapterSessionId');
      expect(receivedRequests[0].sessionContext?.nativeLocality).toEqual({
        kind: 'degrade',
        reason: 'agent-already-started',
      });
    });

    it('allows native resume when no live agent holds the adapterSessionId', async () => {
      registerListAgentsHandler(ctx, [
        { agentId: 'other-agent', sessionId: 'other-session', adapterSessionId: 'different-session' },
      ]);
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        mode: 'resume',
        adapterSessionId: nativeAdapterSessionId,
      });
    });

    it('allows native resume when adapter has no live agents at all', async () => {
      registerListAgentsHandler(ctx, []);
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        mode: 'resume',
        adapterSessionId: nativeAdapterSessionId,
      });
    });

    it('allows native resume when listAgents handler is not registered (safe default)', async () => {
      // No listAgents handler registered — requestOptional returns { handled: false }
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
        }),
        localMachine,
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        mode: 'resume',
        adapterSessionId: nativeAdapterSessionId,
      });
    });

    it('rejects the second of two concurrent resume-attaches to the same adapterSessionId', async () => {
      // Simulate the adapter's claim-based guard: the first resume-mode
      // startAgent succeeds; the second for the same adapterSessionId fails
      // because the claim is already held. This covers the TOCTOU window
      // where both attaches pass the listAgents live-writer guard before
      // either agent registers.
      registerListAgentsHandler(ctx, []);

      const session = ctx.createMockSession({
        machineId: localMachine,
        adapterSessionId: nativeAdapterSessionId,
      });
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(session));
      ctx.trackUnsubscribe(ctx.registerHandler(localMachine));

      // Track claimed adapterSessionIds to simulate registry.claimAdapterSession.
      // The handler is synchronous: the first resume claim succeeds, the second
      // for the same adapterSessionId is rejected immediately.
      const claimedSessions = new Set<string>();
      const receivedRequests: StartAgentRequestPayload[] = [];
      let agentCounter = 0;
      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubjects.startAgent, (context) => {
          receivedRequests.push(context.payload);
          const payload = context.payload;
          const payloadAdapterSessionId =
            'adapterSessionId' in payload ? (payload.adapterSessionId as string | undefined) : undefined;

          if (payload.mode === 'resume' && payloadAdapterSessionId) {
            if (claimedSessions.has(payloadAdapterSessionId)) {
              context.setResult({
                success: false,
                message: `Provider session ${payloadAdapterSessionId} is already claimed`,
              });
              return;
            }
            claimedSessions.add(payloadAdapterSessionId);
          }

          agentCounter++;
          context.setResult({
            success: true,
            agentId: `agent-${agentCounter}`,
            adapterId: context.payload.adapterId,
            adapterSessionId: ATTACH_TEST_IDS.adapterSessionId,
            sessionId: ATTACH_TEST_IDS.sessionId,
            messageId: ATTACH_TEST_IDS.messageId,
          });
        }),
      );

      // Fire both attaches concurrently and collect results
      const results = await Promise.allSettled([
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
        }),
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
        }),
      ]);

      // Both requests sent resume-mode startAgent
      const resumeRequests = receivedRequests.filter((r) => r.mode === 'resume');
      expect(resumeRequests).toHaveLength(2);

      // Exactly one succeeds and one fails (adapter rejects the duplicate claim)
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('Failed to start agent');
    });
  });

  describe('conversation history seeding on degrade', () => {
    /**
     * Registers mock handlers for the getFullConversation chain:
     * SessionStorageSubjects.get (chain walk), SessionEventStorageSubjects.getEvents,
     * and MessageStorageSubjects.get. Returns stored messages for assertions.
     * @param testCtx - Test context for cleanup tracking
     * @param session - Session record for the storage-level get
     * @param messages - Messages to return from the conversation chain
     */
    function registerConversationMocks(
      testCtx: AttachHandlerTestContext,
      session: IMakaioSession,
      messages: SessionMessage[],
    ): void {
      // getFullConversation calls SessionStorageSubjects.get for the parent chain walk.
      testCtx.trackUnsubscribe(
        MakaioBus.on(SessionStorageSubjects.get, (context) => {
          if (context.payload.sessionId === session.sessionId) {
            context.setResult({ session });
          } else {
            context.setResult({ session: null });
          }
        }),
      );

      // Build message events from the provided messages.
      const events: MakaioSessionEvent[] = messages.map((msg, i) => ({
        sessionId: session.sessionId,
        eventId: `event-${msg.messageId}`,
        timestamp: msg.timestamp + i,
        type: 'message' as const,
        payload: { messageId: msg.messageId, turnId: msg.turnId, role: msg.role },
      }));

      testCtx.trackUnsubscribe(
        MakaioBus.on(SessionEventStorageSubjects.getEvents, (context) => {
          context.setResult({ events, nextCursor: null });
        }),
      );

      // Individual message retrieval by messageId.
      const messageMap = new Map(messages.map((m) => [m.messageId, m]));
      testCtx.trackUnsubscribe(
        MakaioBus.on(MessageStorageSubjects.get, (context) => {
          const msg = messageMap.get(context.payload.messageId) ?? null;
          context.setResult({ message: msg });
        }),
      );
    }

    /**
     * Creates a minimal SessionMessage for testing conversation seeding.
     * @param id - Message ID
     * @param role - Message role
     * @param content - Text content
     */
    function createTestMessage(id: string, role: 'user' | 'assistant', content: string): SessionMessage {
      return {
        messageId: id,
        sessionId,
        turnId: 'turn-1',
        role,
        contentText: content,
        blocks: [{ type: 'text', content }],
        timestamp: Date.now(),
      };
    }

    it('seeds messageHistory and isFirstTurn when attach degrades on a session with history', async () => {
      const storedMessages = [
        createTestMessage('msg-1', 'user', 'Hello'),
        createTestMessage('msg-2', 'assistant', 'Hi there'),
      ];
      const session = ctx.createMockSession({
        machineId: remoteMachine,
        adapterSessionId: nativeAdapterSessionId,
      });

      registerConversationMocks(ctx, session, storedMessages);
      const receivedRequests = setupLocalityTest(ctx, session, localMachine);

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      const req = receivedRequests[0];
      expect(req.sessionContext?.nativeLocality).toEqual({
        kind: 'foreign',
        machineId: remoteMachine,
      });
      expect(req.sessionContext?.isFirstTurn).toBe(true);
      expect(req.sessionContext?.messageHistory).toEqual([
        { role: 'user', blocks: [{ type: 'text', content: 'Hello' }] },
        { role: 'assistant', blocks: [{ type: 'text', content: 'Hi there' }] },
      ]);
    });

    it('seeds messageHistory when attach degrades due to adapter-unsupported', async () => {
      ctx.setDefaultAdapterCapabilities([]);
      const storedMessages = [createTestMessage('msg-1', 'user', 'prior turn')];
      const session = ctx.createMockSession({
        machineId: localMachine,
        adapterSessionId: nativeAdapterSessionId,
        isImported: true,
        isOrchestrated: false,
      });

      registerConversationMocks(ctx, session, storedMessages);
      const receivedRequests = setupLocalityTest(ctx, session, localMachine);

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      const req = receivedRequests[0];
      expect(req.sessionContext?.nativeLocality).toEqual({
        kind: 'degrade',
        reason: 'adapter-unsupported',
      });
      expect(req.sessionContext?.isFirstTurn).toBe(true);
      expect(req.sessionContext?.messageHistory).toHaveLength(1);
      expect(req.sessionContext?.messageHistory?.[0]).toEqual({
        role: 'user',
        blocks: [{ type: 'text', content: 'prior turn' }],
      });
    });

    it('omits messageHistory when attach degrades on an empty session', async () => {
      const session = ctx.createMockSession({
        machineId: remoteMachine,
        adapterSessionId: nativeAdapterSessionId,
      });

      // Empty conversation: no events, no messages.
      registerConversationMocks(ctx, session, []);
      const receivedRequests = setupLocalityTest(ctx, session, localMachine);

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      const req = receivedRequests[0];
      expect(req.sessionContext?.nativeLocality).toEqual({
        kind: 'foreign',
        machineId: remoteMachine,
      });
      // Empty sessions must not get an empty-array messageHistory field.
      expect(req.sessionContext?.messageHistory).toBeUndefined();
      expect(req.sessionContext?.isFirstTurn).toBeUndefined();
    });

    it('does not include messageHistory on native resume attach', async () => {
      const storedMessages = [
        createTestMessage('msg-1', 'user', 'Hello'),
        createTestMessage('msg-2', 'assistant', 'Hi there'),
      ];
      const session = ctx.createMockSession({
        machineId: localMachine,
        adapterSessionId: nativeAdapterSessionId,
        isImported: true,
        isOrchestrated: false,
      });

      // Register conversation mocks even though native resume should not use them.
      registerConversationMocks(ctx, session, storedMessages);
      const receivedRequests = setupLocalityTest(ctx, session, localMachine);

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(receivedRequests).toHaveLength(1);
      const req = receivedRequests[0];
      expect(req.mode).toBe('resume');
      expect(req).not.toHaveProperty('sessionContext');
    });
  });
});
