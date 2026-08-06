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
import { buildDeterministicAdapterId } from '../../../adapter-runtime/index.js';
import {
  ATTACH_TEST_IDS,
  createAttachHandlerContext,
  holdProviderSession,
  type AttachHandlerTestContext,
  type StartAgentRequestPayload,
} from './shared.js';

/**
 * Poll until a condition is met, with a bounded timeout.
 *
 * Replaces fixed `setTimeout` waits — eliminates both the DRY violation
 * and CI flakiness from hard-coded delays.
 * @param predicate - Condition to wait for
 * @param timeoutMs - Maximum time to wait before failing
 * @param intervalMs - Polling interval
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 500, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

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

  /**
   * The attach face of the one-identity rule (#1140 Wave 4 Step 5, case 213/214).
   *
   * A caller-named instance used to be refused native resume outright, whatever
   * the session said, because an instance ID is a one-way hash of
   * `(machineId, adapterName)` and the machine could not be recovered from it —
   * so every ownership act would have run under *this* runtime's identity against
   * somebody else's instance. With the machine named alongside the instance the
   * whole attach runs in that machine's namespace, and locality is decided on its
   * merits instead.
   *
   * Either half named without the other is refused before the attach starts
   * anything — one rule, the same one the send and fresh-start paths raise.
   */
  describe('when the caller names an adapter instance', () => {
    /**
     * Announce an instance so the reverse lookup can name its adapter type.
     * @param machineId - Machine the instance belongs to.
     * @returns The announced instance ID.
     */
    async function announceInstance(machineId: string): Promise<string> {
      const adapterId = buildDeterministicAdapterId(machineId, adapterName);
      await ctx.registerKnownAdapter(adapterName, adapterId);
      return adapterId;
    }

    it('resumes natively on a named instance whose machine owns the session', async () => {
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
      const adapterId = await announceInstance(localMachine);

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, adapterId, machineId: localMachine },
      });

      // The named instance is both the dispatch target and the identity the
      // verdict was evaluated under — one pair, and native because the pair is
      // provable rather than because the handler stopped asking.
      expect(receivedRequests[0]).toMatchObject({
        adapterId,
        mode: 'resume',
        adapterSessionId: nativeAdapterSessionId,
      });
      expect(receivedRequests[0]).not.toHaveProperty('sessionContext');
    });

    it('reports a named instance on another machine as foreign, not as a missing machine', async () => {
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
      const adapterId = await announceInstance(remoteMachine);

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, adapterId, machineId: remoteMachine },
      });

      // The verdict is evaluated under the machine the caller named, so the
      // session's own machine is what it is compared against — a precise answer
      // where the old short-circuit could only say "no machine".
      expect(receivedRequests[0]).not.toHaveProperty('mode');
      expect(receivedRequests[0].sessionContext?.nativeLocality).toEqual({
        kind: 'foreign',
        machineId: localMachine,
      });
    });

    it('refuses an instance named without its machine, rather than starting on a guessed one', async () => {
      // The shape the selection schema forbids, dispatched over a bus that does
      // not validate — the composition in which only the handler answers.
      //
      // This half used to be served as a `missing-machine-id` locality degrade,
      // on the grounds that a fresh-with-history conversation is still worth
      // offering. It is not worth offering on a guessed machine: the degraded
      // attach *starts*, and the settlement that follows files the provider
      // session the connector confirms under this runtime's own machine while the
      // dispatch addressed the named instance. The claim then sits under a pair
      // no owner computes, so the runtime that really owns the instance can claim
      // the same provider session beside it. The protected fact survives as the
      // refusal: an attach with no provable instance does not start.
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
      const adapterId = await announceInstance(remoteMachine);

      const failure = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, adapterId },
      }).catch((error: unknown) => error);

      expect(String(failure)).toContain(`named adapter instance ${adapterId} without its machine`);
      expect(receivedRequests).toEqual([]);
      // And no claim was filed on the way out. The reservation precedes the
      // dispatch, so an absent start does not on its own prove an untouched key —
      // a foreign generation still taking the session's native key does.
      await holdProviderSession({
        sessionId,
        agentId: 'later-owner',
        adapterId: buildDeterministicAdapterId(localMachine, adapterName),
        adapterName,
        machineId: localMachine,
        providerSessionId: nativeAdapterSessionId,
      });
    });

    it('names the half-identity even when the adapter could not have resumed anyway', async () => {
      // Why the refusal stays a decision of its own instead of being left to the
      // locality evaluator: the evaluator checks capability and currency *first*,
      // so it would report `adapter-unsupported` here and say nothing about the
      // caller having named half an identity — and it would say it about an attach
      // that already started. Decided before anything is read, the diagnosis does
      // not depend on which unrelated check happens to come first.
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
      const adapterId = await announceInstance(localMachine);

      const failure = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, adapterId },
      }).catch((error: unknown) => error);

      expect(String(failure)).toContain(`named adapter instance ${adapterId} without its machine`);
      expect(receivedRequests).toEqual([]);
    });

    it('refuses a machine named with no instance on it, rather than attaching on this one', async () => {
      // The pair's *other* half, over the same non-validating bus — and the one
      // that has no degrade to offer. The branch a selection without an instance
      // takes derives one for the machine this runtime runs on and reads the named
      // machine nowhere, so the alternative to refusing is an attach on this host
      // for a caller that chose another. Same rule as the send path's refusal, and
      // the reason it needs stating on both is that each path has its own branch
      // that ignores the field.
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
      await announceInstance(remoteMachine);

      const failure = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName, machineId: remoteMachine },
      }).catch((error: unknown) => error);

      expect(String(failure)).toContain(`named machine ${remoteMachine} without an adapter instance on it`);
      // Refused before the start: nothing was dispatched anywhere, least of all to
      // the local instance the ignored machine used to land on.
      expect(receivedRequests).toEqual([]);
    });
  });

  describe('occupancy (agent-already-started)', () => {
    /**
     * Take a generation for a foreign agent on the session's native key.
     *
     * Occupancy is a claim row decided inside the reserving transaction, so the
     * fixture holds a real generation rather than mocking a liveness probe the
     * attach path no longer asks (I17).
     * @param providerSessionId - Provider session the foreign generation owns
     */
    async function holdSession(providerSessionId: string): Promise<void> {
      await holdProviderSession({
        sessionId,
        agentId: 'existing-agent',
        adapterId: buildDeterministicAdapterId(localMachine, adapterName),
        adapterName,
        machineId: localMachine,
        providerSessionId,
      });
    }

    it('degrades to agent-already-started when another generation holds the provider session', async () => {
      const receivedRequests = setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
        }),
        localMachine,
      );
      await holdSession(nativeAdapterSessionId);

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

    it('allows native resume when no generation holds the adapterSessionId', async () => {
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

    it('never asks the adapter who is live — no path probes listAgents (I17)', async () => {
      // The probe is gone, and its answer is unreachable: a handler that would
      // have reported a live writer on the very key being resumed is registered
      // and must never be asked. The reservation is the only occupancy decision.
      let probes = 0;
      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubjects.listAgents, (context) => {
          probes += 1;
          context.setResult({
            agents: [{ agentId: 'existing-agent', sessionId, adapterSessionId: nativeAdapterSessionId }],
          });
        }),
      );
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

      expect(probes).toBe(0);
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        mode: 'resume',
        adapterSessionId: nativeAdapterSessionId,
      });
    });

    it('lets exactly one of two concurrent resume-attaches take the provider session', async () => {
      // The window the deleted live-writer probe could never close: both
      // attaches read a free provider session, and both used to dispatch
      // `mode: 'resume'` against it. Ownership decides it inside the reserving
      // transaction now, so the loser degrades to fresh-with-history instead of
      // becoming a second writer — and neither attach fails.
      const session = ctx.createMockSession({
        machineId: localMachine,
        adapterSessionId: nativeAdapterSessionId,
      });
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(session));
      ctx.trackUnsubscribe(ctx.registerHandler(localMachine));

      const receivedRequests: StartAgentRequestPayload[] = [];
      let agentCounter = 0;
      ctx.trackUnsubscribe(
        MakaioBus.on(AdapterSubjects.startAgent, (context) => {
          receivedRequests.push(context.payload);
          agentCounter += 1;
          context.setResult({
            success: true,
            agentId: context.payload.agentId ?? `agent-${agentCounter}`,
            adapterId: context.payload.adapterId,
            // Distinct per start: the degraded attach lands on a provider
            // session of its own, which is the whole point of the degrade.
            adapterSessionId: `${ATTACH_TEST_IDS.adapterSessionId}-${agentCounter}`,
            sessionId: ATTACH_TEST_IDS.sessionId,
            messageId: ATTACH_TEST_IDS.messageId,
          });
        }),
      );

      // Both as members: a concurrent *lead* race is a different decision with a
      // different answer (`lead-conflict`), and this case is about the key.
      const results = await Promise.allSettled([
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          role: 'member',
        }),
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          role: 'member',
        }),
      ]);

      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      // Exactly one resume, and the loser carries seeded history instead of an
      // empty provider context.
      const resumeRequests = receivedRequests.filter((request) => request.mode === 'resume');
      const freshRequests = receivedRequests.filter((request) => request.mode !== 'resume');
      expect(resumeRequests).toHaveLength(1);
      expect(freshRequests).toHaveLength(1);
      expect(freshRequests[0].sessionContext?.nativeLocality).toEqual({
        kind: 'degrade',
        reason: 'agent-already-started',
      });
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

  describe('locality.degraded bus event emission', () => {
    /**
     * Captures `session.locality.degraded` events emitted during a test.
     * @param testCtx - Test context for cleanup tracking
     * @returns Array that receives emitted payloads
     */
    function captureDegradeEvents(testCtx: AttachHandlerTestContext): Array<{
      sessionId: string;
      eventId: string;
      timestamp: number;
      intent: string;
      verdictKind: string;
      reason?: string;
      foreignMachineId?: string;
    }> {
      const captured: Array<{
        sessionId: string;
        eventId: string;
        timestamp: number;
        intent: string;
        verdictKind: string;
        reason?: string;
        foreignMachineId?: string;
      }> = [];
      testCtx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.locality.degraded, ({ payload }) => {
          captured.push(payload);
        }),
      );
      return captured;
    }

    it('emits locality.degraded with reason when adapter is unsupported', async () => {
      ctx.setDefaultAdapterCapabilities([]);
      const captured = captureDegradeEvents(ctx);
      setupLocalityTest(
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

      // Wait for async emit to settle.
      await waitUntil(() => captured.length >= 1);

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        sessionId,
        intent: 'resume',
        verdictKind: 'degrade',
        reason: 'adapter-unsupported',
      });
    });

    it('emits locality.degraded with foreign verdictKind for remote machine', async () => {
      const captured = captureDegradeEvents(ctx);
      setupLocalityTest(
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

      await waitUntil(() => captured.length >= 1);

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        sessionId,
        intent: 'resume',
        verdictKind: 'foreign',
        foreignMachineId: remoteMachine,
      });
    });

    it('emits locality.degraded for agent-already-started live-writer guard', async () => {
      const captured = captureDegradeEvents(ctx);
      setupLocalityTest(
        ctx,
        ctx.createMockSession({
          machineId: localMachine,
          adapterSessionId: nativeAdapterSessionId,
        }),
        localMachine,
      );
      await holdProviderSession({
        sessionId,
        agentId: 'existing-agent',
        adapterId: buildDeterministicAdapterId(localMachine, adapterName),
        adapterName,
        machineId: localMachine,
        providerSessionId: nativeAdapterSessionId,
      });

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      await waitUntil(() => captured.length >= 1);

      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        sessionId,
        intent: 'resume',
        verdictKind: 'degrade',
        reason: 'agent-already-started',
      });
    });

    it('carries stable eventId and timestamp in both the persisted row and the live event', async () => {
      ctx.setDefaultAdapterCapabilities([]);
      const captured = captureDegradeEvents(ctx);

      // Capture the persisted event via the storage append subject.
      const persisted: MakaioSessionEvent[] = [];
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionEventStorageSubjects.append, (context) => {
          persisted.push(context.payload.event);
          context.setResult({ success: true });
        }),
      );

      setupLocalityTest(
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

      await waitUntil(() => captured.length >= 1 && persisted.length >= 1);

      expect(persisted).toHaveLength(1);
      expect(captured).toHaveLength(1);

      // The same eventId and timestamp must appear in both paths.
      expect(captured[0].eventId).toBe(persisted[0].eventId);
      expect(captured[0].timestamp).toBe(persisted[0].timestamp);
      expect(typeof captured[0].eventId).toBe('string');
      expect(captured[0].eventId.length).toBeGreaterThan(0);
      expect(typeof captured[0].timestamp).toBe('number');
    });

    it('does not emit locality.degraded for native resume', async () => {
      const captured = captureDegradeEvents(ctx);
      setupLocalityTest(
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

      // Absence assertion: give async paths a generous window to settle
      // before asserting no events were emitted.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(captured).toHaveLength(0);
    });
  });
});
