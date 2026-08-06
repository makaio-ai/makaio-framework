/**
 * Component tests for MakaioSessionService - Agent management.
 *
 * Tests the agent.added / agent.removed event handling: role assignment, lead
 * designation through the reserving transaction, and lastActivityAt updates.
 * Uses real bus requests against the real memory backends — session, agent and
 * ownership rows share one state, because a designation is a compare-and-swap
 * that reads the agent row and writes the session row inside one transaction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type IMakaioSession,
} from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { designateSessionLead } from '../ownership/index.js';
import { registerMemorySessionBackends } from './shared.js';

describe('MakaioSessionService - Agent Management', () => {
  let sessionService: MakaioSessionService;
  let storageCleanups: Array<() => void> = [];

  /** What both agent helpers are given. */
  interface AgentParams {
    sessionId: string;
    agentId: string;
    adapterId: string;
    adapterName: string;
    /** Absent for a reserved start, which withholds it from the announcement. */
    adapterSessionId?: string;
    role?: 'lead' | 'member';
    model?: string;
    cwd?: string;
  }

  /**
   * Persist an agent row, as the adapter does before it announces the agent.
   *
   * Its own step, because the reserving transaction verifies the (agent, session)
   * pair: a designation for an agent whose row is not there yet is refused, which
   * is what makes the announcement's ordering load-bearing rather than incidental.
   * @param params - Agent parameters
   */
  async function persistAgent(params: AgentParams): Promise<void> {
    const now = Date.now();
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: params.agentId,
      agent: {
        agentId: params.agentId,
        adapterId: params.adapterId,
        adapterName: params.adapterName,
        sessionId: params.sessionId,
        adapterSessionId: params.adapterSessionId,
        role: params.role ?? 'lead',
        status: 'idle',
        createdAt: now,
        lastActivityAt: now,
        model: params.model,
        cwd: params.cwd,
      },
    });
  }

  /**
   * Announce an agent and wait for the session service's handler to finish.
   * @param params - Agent parameters
   */
  async function emitAgentAdded(params: AgentParams): Promise<void> {
    await MakaioBus.emit(SessionSubjects.agent.added, {
      sessionId: params.sessionId,
      agentId: params.agentId,
      adapterId: params.adapterId,
      adapterName: params.adapterName,
      adapterSessionId: params.adapterSessionId,
      role: params.role ?? 'lead',
      model: params.model,
      cwd: params.cwd,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Helper to persist an agent and emit agent.added event.
   * Simulates what the adapter does.
   * @param params - Agent parameters
   */
  async function addAgent(params: AgentParams): Promise<void> {
    await persistAgent(params);
    await emitAgentAdded(params);
  }

  beforeEach(async () => {
    // Register storage handlers BEFORE creating the service
    storageCleanups = [...registerMemorySessionBackends(MakaioBus), registerMemorySessionEventStorage(MakaioBus)];

    // Create the service (constructor has no side effects)
    sessionService = new MakaioSessionService(MakaioBus);
    // Initialize the service (registers handlers)
    await sessionService.init();
  });

  afterEach(async () => {
    // Clean up in reverse order
    await sessionService.destroy();
    for (let index = storageCleanups.length - 1; index >= 0; index -= 1) storageCleanups[index]();
    storageCleanups = [];
  });

  describe('session.agent.added event handling', () => {
    it('should add agent to session on agent.added event', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      await addAgent({
        sessionId,
        agentId: 'agent-123',
        adapterId: 'adapter-456',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-789',
      });

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session).not.toBeNull();
      expect(session?.agents).toHaveLength(1);
      expect(session?.agents[0].agentId).toBe('agent-123');
      expect(session?.agents[0].adapterId).toBe('adapter-456');
      expect(session?.agents[0].adapterName).toBe('test-adapter');
      expect(session?.agents[0].createdAt).toBeDefined();
    });

    it('should set first agent as lead role', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      await addAgent({
        sessionId,
        agentId: 'first-agent',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
      });

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session?.agents[0].role).toBe('lead');
      expect(session?.leadAgentId).toBe('first-agent');
    });

    it('stamps no identity for a lead the session lost while the handler worked', async () => {
      // The designation made this agent the lead, and the identity write rests on
      // that designation still standing — so the lead the predicate names is
      // *this* agent's. A `session.agent.removed` in between clears the
      // designation under a swap naming the departing agent, which on a fresh
      // session leaves `leadAgentId` back at the `undefined` this handler
      // observed. Accepting that observed value stamped the identity for an agent
      // that was already gone, and write-once left no later lead able to correct
      // it.
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      await persistAgent({
        sessionId,
        agentId: 'lead-removed-mid-handler',
        adapterId: 'doomed-adapter-instance',
        adapterName: 'doomed-adapter',
        adapterSessionId: 'doomed-provider-session',
      });

      const gate = suspendAfterDesignation();
      const announced = emitAgentAdded({
        sessionId,
        agentId: 'lead-removed-mid-handler',
        adapterId: 'doomed-adapter-instance',
        adapterName: 'doomed-adapter',
        adapterSessionId: 'doomed-provider-session',
        role: 'lead',
      });

      // The removal's effect on the designation, driven through the one writer
      // that produces it. Emitting `session.agent.removed` here would widen the
      // case rather than sharpen it: that handler disposes the agent and releases
      // its claims too, and what this window is about is the designation being
      // cleared under the swap that names the departing agent — exactly this call.
      await gate.reached;
      const cleared = await designateSessionLead(MakaioBus, {
        sessionId,
        agentId: 'lead-removed-mid-handler',
        expectedLeadAgentId: 'lead-removed-mid-handler',
        clear: true,
      });
      expect(cleared?.outcome).toBe('claimed');
      gate.release();
      await announced;
      gate.unsubscribe();

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(session?.leadAgentId).toBeUndefined();
      // Nothing was stamped: the session's identity is still open for the lead
      // that actually leads it.
      expect(session?.adapterName).toBeUndefined();
      expect(session?.adapterId).toBeUndefined();
      expect(session?.adapterSessionId).toBeUndefined();
    });

    it('leaves a peer’s identity standing when it lands inside the write window', async () => {
      // The atomicity the predicate buys, at the seam that used to lack it. Two
      // writers legitimately speak for the same lead — this announcement, and the
      // reconciliation of the same agent's first confirmed turn — and the loser
      // used to carry back a record it had assembled before the winner wrote.
      // The check now travels inside the write, so the loser matches nothing.
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      await persistAgent({
        sessionId,
        agentId: 'lead-outraced',
        adapterId: 'slow-adapter-instance',
        adapterName: 'slow-adapter',
        adapterSessionId: 'slow-provider-session',
      });

      const gate = suspendAfterDesignation();
      const announced = emitAgentAdded({
        sessionId,
        agentId: 'lead-outraced',
        adapterId: 'slow-adapter-instance',
        adapterName: 'slow-adapter',
        adapterSessionId: 'slow-provider-session',
        role: 'lead',
      });

      await gate.reached;
      const peer = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId,
        identity: {
          adapterName: 'peer-adapter',
          adapterId: 'peer-adapter-instance',
          adapterSessionId: 'peer-provider-session',
        },
        expectIdentityOpenForLead: 'lead-outraced',
      });
      expect(peer.success).toBe(true);
      gate.release();
      await announced;
      gate.unsubscribe();

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(session?.adapterName).toBe('peer-adapter');
      expect(session?.adapterId).toBe('peer-adapter-instance');
      expect(session?.adapterSessionId).toBe('peer-provider-session');
      // The announcement still happened, and its one unconditional product is
      // written on the refusal path rather than lost with the identity.
      expect(session?.lastActivityAt).toBeGreaterThan(0);
    });

    it('leaves the identity open for the lead when a member arrives first', async () => {
      // The designation, not the snapshot, answers whose identity the session
      // carries. A member can reach this handler before its session's lead —
      // two processes, or two starts interleaved — and the row it reads names
      // no lead yet. Establishing from that snapshot would fix the session on
      // the member's adapter for good: nothing reopens an established identity.
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      await addAgent({
        sessionId,
        agentId: 'early-member',
        adapterId: 'member-instance',
        adapterName: 'member-adapter',
        adapterSessionId: 'member-provider-session',
        role: 'member',
      });

      const afterMember = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
      expect(afterMember?.adapterName).toBeUndefined();
      expect(afterMember?.adapterId).toBeUndefined();
      expect(afterMember?.adapterSessionId).toBeUndefined();
      expect(afterMember?.leadAgentId).toBeUndefined();

      await addAgent({
        sessionId,
        agentId: 'late-lead',
        adapterId: 'lead-instance',
        adapterName: 'lead-adapter',
        adapterSessionId: 'lead-provider-session',
        role: 'lead',
      });

      const afterLead = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
      expect(afterLead?.adapterName).toBe('lead-adapter');
      expect(afterLead?.adapterId).toBe('lead-instance');
      expect(afterLead?.adapterSessionId).toBe('lead-provider-session');
      expect(afterLead?.leadAgentId).toBe('late-lead');
    });

    it('follows the lead for the session identity, not the first agent it observes', async () => {
      // A reserved start withholds its provider session from this event — the
      // settlement that claims the key publishes it — so the session's identity
      // is established without one. Reading "is this the first agent" off that
      // absent field would make the next agent the first all over again, and a
      // member on any adapter would restamp the session with its own identity.
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      await addAgent({
        sessionId,
        agentId: 'reserved-lead',
        adapterId: 'lead-adapter-instance',
        adapterName: 'lead-adapter',
        role: 'lead',
      });
      // Asserted, not assumed: the identity really was established without a
      // provider session, which is the state the old test read as "unset".
      const afterLead = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
      expect(afterLead?.adapterName).toBe('lead-adapter');
      expect(afterLead?.adapterSessionId).toBeUndefined();

      await addAgent({
        sessionId,
        agentId: 'later-member',
        adapterId: 'member-adapter-instance',
        adapterName: 'member-adapter',
        adapterSessionId: 'member-provider-session',
        role: 'member',
      });

      const session = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
      expect(session?.adapterName).toBe('lead-adapter');
      expect(session?.adapterId).toBe('lead-adapter-instance');
      expect(session?.adapterSessionId).toBeUndefined();
      expect(session?.leadAgentId).toBe('reserved-lead');

      // And the identity stays established once it is, which is the half the
      // absent provider session used to answer. A replacement lead moves the
      // designation and leaves the session's adapter identity where the first
      // one set it — the behaviour a session with a provider session always
      // had, and the one a reserved start must not silently lose.
      await addAgent({
        sessionId,
        agentId: 'replacement-lead',
        adapterId: 'replacement-adapter-instance',
        adapterName: 'replacement-adapter',
        adapterSessionId: 'replacement-provider-session',
        role: 'lead',
      });

      const afterReplacement = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
      expect(afterReplacement?.adapterName).toBe('lead-adapter');
      expect(afterReplacement?.adapterId).toBe('lead-adapter-instance');
      expect(afterReplacement?.adapterSessionId).toBeUndefined();
      expect(afterReplacement?.leadAgentId).toBe('replacement-lead');
    });

    it('backfills the session provider key from the lead, never from a member beside it', async () => {
      // The same rule at the sibling consumer. The reconciliation handler fills
      // the session's provider key while it is absent — which a reserved lead
      // now leaves it for longer — and the key it writes is the session's resume
      // target, so it follows the lead. A same-adapter member confirming first
      // would point the session at a conversation that is not its own.
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      await addAgent({
        sessionId,
        agentId: 'confirming-lead',
        adapterId: 'shared-adapter-instance',
        adapterName: 'shared-adapter',
        role: 'lead',
      });
      await addAgent({
        sessionId,
        agentId: 'confirming-member',
        adapterId: 'shared-adapter-instance',
        adapterName: 'shared-adapter',
        role: 'member',
      });

      await MakaioBus.emit(AgentSubjects.started, {
        agentId: 'confirming-member',
        adapterId: 'shared-adapter-instance',
        adapterName: 'shared-adapter',
        adapterSessionId: 'member-provider-session',
        sessionId,
        model: 'test-model',
        cwd: '/tmp',
        startMode: 'fresh',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await MakaioBus.request(SessionSubjects.get, { sessionId })).session?.adapterSessionId).toBeUndefined();

      await MakaioBus.emit(AgentSubjects.started, {
        agentId: 'confirming-lead',
        adapterId: 'shared-adapter-instance',
        adapterName: 'shared-adapter',
        adapterSessionId: 'lead-provider-session',
        sessionId,
        model: 'test-model',
        cwd: '/tmp',
        startMode: 'fresh',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await MakaioBus.request(SessionSubjects.get, { sessionId })).session?.adapterSessionId).toBe(
        'lead-provider-session',
      );
    });

    /**
     * Answer the next session read with a **materialised** snapshot, suspended
     * until the caller lets it through.
     *
     * Two things this models, both load-bearing. The window under test is
     * *inside* the handler — it reads the session, and the close lands before it
     * writes — so the read has to be held open. And the answer has to be the
     * snapshot the caller supplied rather than a delegated read: what the case is
     * about is a handler acting on a row it observed *before* the interleaved
     * write, and a handler that saw the newer value would carry it back by
     * accident and hide the defect.
     * @param snapshot - The session as the handler's read observed it.
     * @returns The release callback and the injector's unsubscribe.
     */
    function suspendNextSessionRead(snapshot: IMakaioSession): { release: () => void; unsubscribe: () => void } {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let answered = false;
      const unsubscribe = MakaioBus.on(
        SessionStorageSubjects.get,
        async (ctx) => {
          if (answered) {
            ctx.next();
            return;
          }
          answered = true;
          await gate;
          ctx.setResult({ session: { ...snapshot, agents: snapshot.agents.map((agent) => ({ ...agent })) } });
        },
        { priority: 100 },
      );
      return { release, unsubscribe };
    }

    /**
     * Hold the announcement handler open **between its designation and its
     * identity write**, and let every later designation through.
     *
     * This is the window the conditional identity write exists for. The handler
     * has designated a lead, has assembled the identity it means to publish, and
     * has not written it yet; whatever a peer does to the row in that gap is what
     * the write must be measured against. Suspending after the *designation*
     * rather than after a read is what makes the window real: the write no longer
     * re-reads, so there is no second read to hold.
     *
     * The gate opens after `ctx.next()`, so the designation has already been
     * written by the real reserving transaction by the time the caller acts —
     * the interleaving under test, not a guess about scheduling.
     * @returns The reached signal, the release callback and the unsubscribe.
     */
    function suspendAfterDesignation(): { reached: Promise<void>; release: () => void; unsubscribe: () => void } {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let announceReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        announceReached = resolve;
      });
      let suspended = false;
      const unsubscribe = MakaioBus.on(
        SessionOwnershipStorageSubjects.claim,
        async (ctx) => {
          await ctx.next();
          // Only the first designation — the announcement's own. The peer acts
          // through this same subject while the gate is held, and it must not be
          // held by it.
          if (suspended) return;
          suspended = true;
          announceReached();
          await gate;
        },
        { priority: 100 },
      );
      return { reached, release, unsubscribe };
    }

    it('does not revive a session that closed while the announcement was handled', async () => {
      // A whole-record write carries every column of the snapshot this handler
      // read — including `status`. A `session.close` landing between that read
      // and the write is undone by it: the session goes back to `active` after
      // the lifecycle event that ended it, and work is admitted against a
      // session whose connector may already be gone. The ordinary path therefore
      // writes the one field this announcement produces.
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      await addAgent({
        sessionId,
        agentId: 'lead-before-close',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
      });

      const observed = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
      if (!observed) throw new Error('seeded session is missing');
      const gate = suspendNextSessionRead(observed);
      await persistAgent({
        sessionId,
        agentId: 'member-across-close',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-2',
        role: 'member',
      });
      const announced = emitAgentAdded({
        sessionId,
        agentId: 'member-across-close',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-2',
        role: 'member',
      });

      // The session ends while that handler is suspended on its read.
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });
      gate.release();
      await announced;
      gate.unsubscribe();

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(session?.status).toBe('closed');
      // And the identity the first lead established is untouched.
      expect(session?.adapterSessionId).toBe('adapter-session-1');
    });

    it('does not revive a closed session when an agent is removed across the close', async () => {
      // The removal handler's write is activity-only for the same reason.
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      await addAgent({
        sessionId,
        agentId: 'lead-then-removed',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
      });

      const observed = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
      if (!observed) throw new Error('seeded session is missing');
      const gate = suspendNextSessionRead(observed);
      const removed = MakaioBus.emit(SessionSubjects.agent.removed, { sessionId, agentId: 'lead-then-removed' });
      await MakaioBus.request(SessionStorageSubjects.update, { sessionId, status: 'closed' });
      gate.release();
      await removed;
      gate.unsubscribe();

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(session?.status).toBe('closed');
    });

    it('should set subsequent agents as member role', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      // Add first agent (will be lead)
      await addAgent({
        sessionId,
        agentId: 'first-agent',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
      });

      // Add second agent (should be member)
      await addAgent({
        sessionId,
        agentId: 'second-agent',
        adapterId: 'adapter-2',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-2',
        role: 'member',
      });

      // Add third agent (should also be member)
      await addAgent({
        sessionId,
        agentId: 'third-agent',
        adapterId: 'adapter-3',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-3',
        role: 'member',
      });

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session?.agents).toHaveLength(3);
      expect(session?.agents[0].role).toBe('lead');
      expect(session?.agents[1].role).toBe('member');
      expect(session?.agents[2].role).toBe('member');
      expect(session?.leadAgentId).toBe('first-agent');
    });

    it('should respect explicit role in agent.added event', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      // Add first agent with explicit member role
      await addAgent({
        sessionId,
        agentId: 'first-agent',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
        role: 'member',
      });

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session?.agents[0].role).toBe('member');
      // leadAgentId should not be set since no lead was added
      expect(session?.leadAgentId).toBeUndefined();
    });

    it('should update lastActivityAt on agent added', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      const { session: beforeAdd } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      const originalLastActivity = beforeAdd?.lastActivityAt;

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 5));

      await addAgent({
        sessionId,
        agentId: 'agent-123',
        adapterId: 'adapter-456',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-789',
      });

      const { session: afterAdd } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(afterAdd?.lastActivityAt).toBeGreaterThan(originalLastActivity ?? 0);
    });

    it('should ignore agent.added for non-existent session', async () => {
      // This should not throw - handler just returns early
      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId: 'non-existent-session',
        agentId: 'agent-123',
        adapterId: 'adapter-456',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-789',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify session was not created
      const { session } = await MakaioBus.request(SessionSubjects.get, {
        sessionId: 'non-existent-session',
      });
      expect(session).toBeNull();
    });

    it('should set explicit lead role and update leadAgentId', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      // Add first agent as member
      await addAgent({
        sessionId,
        agentId: 'member-agent',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
        role: 'member',
      });

      // Add second agent as explicit lead
      await addAgent({
        sessionId,
        agentId: 'lead-agent',
        adapterId: 'adapter-2',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-2',
        role: 'lead',
      });

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session?.agents).toHaveLength(2);
      expect(session?.agents[0].role).toBe('member');
      expect(session?.agents[1].role).toBe('lead');
      expect(session?.leadAgentId).toBe('lead-agent');
    });

    it('should preserve createdAt timestamp for each agent', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      const beforeFirst = Date.now();
      await addAgent({
        sessionId,
        agentId: 'first-agent',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-1',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const afterFirst = Date.now();

      const beforeSecond = Date.now();
      await addAgent({
        sessionId,
        agentId: 'second-agent',
        adapterId: 'adapter-2',
        adapterName: 'test-adapter',
        adapterSessionId: 'adapter-session-2',
        role: 'member',
      });
      const afterSecond = Date.now();

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session?.agents[0].createdAt).toBeGreaterThanOrEqual(beforeFirst);
      expect(session?.agents[0].createdAt).toBeLessThanOrEqual(afterFirst);
      expect(session?.agents[1].createdAt).toBeGreaterThanOrEqual(beforeSecond);
      expect(session?.agents[1].createdAt).toBeLessThanOrEqual(afterSecond);
      // Second agent was added later
      expect(session?.agents[1].createdAt).toBeGreaterThanOrEqual(session?.agents[0].createdAt ?? 0);
    });
  });

  describe('lead designation goes through the reserving transaction', () => {
    /**
     * Seed a session with a lead and a member, both persisted and announced.
     * @returns The session and the two agent IDs.
     */
    async function seedLeadAndMember(): Promise<{ sessionId: string; leadId: string; memberId: string }> {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      const leadId = 'lead-agent';
      const memberId = 'member-agent';
      await addAgent({
        sessionId,
        agentId: leadId,
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'provider-1',
        role: 'lead',
      });
      await addAgent({
        sessionId,
        agentId: memberId,
        adapterId: 'adapter-2',
        adapterName: 'test-adapter',
        adapterSessionId: 'provider-2',
        role: 'member',
      });
      return { sessionId, leadId, memberId };
    }

    it('designates through a keyless claim, and a stale whole-record set cannot undo it', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      const preDesignation = (await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session;
      expect(preDesignation?.leadAgentId).toBeUndefined();

      const keylessDesignations: string[] = [];
      const observe = MakaioBus.on(
        SessionOwnershipStorageSubjects.claim,
        (ctx) => {
          if (ctx.payload.providerSessionId === null && ctx.payload.designateLead !== undefined) {
            keylessDesignations.push(ctx.payload.agentId);
          }
        },
        { priority: 100 },
      );
      try {
        await addAgent({
          sessionId,
          agentId: 'lead-agent',
          adapterId: 'adapter-1',
          adapterName: 'test-adapter',
          adapterSessionId: 'provider-1',
          role: 'lead',
        });
      } finally {
        observe();
      }

      // The designation was written by the reserving transaction, not by the
      // whole-record write the handler ends with.
      expect(keylessDesignations).toEqual(['lead-agent']);

      // A caller holding the session as it looked before the designation writes
      // it back wholesale. `set` no longer carries the designation on conflict,
      // so the newer value stands.
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: { ...preDesignation!, title: 'renamed' },
      });

      const stored = (await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session;
      expect(stored?.title).toBe('renamed');
      expect(stored?.leadAgentId).toBe('lead-agent');
    });

    it('leaves a newer lead standing when the handler read is stale', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      const preDesignation = (await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session!;

      await addAgent({
        sessionId,
        agentId: 'winner',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        adapterSessionId: 'provider-1',
        role: 'lead',
      });

      // Stage the losing handler's read: it observes the session exactly as it
      // stood before the winner's designation, so its compare-and-swap presents
      // an expectation the row has already moved past.
      const loser: AgentParams = {
        sessionId,
        agentId: 'loser',
        adapterId: 'adapter-2',
        adapterName: 'test-adapter',
        adapterSessionId: 'provider-2',
        role: 'lead',
      };
      await persistAgent(loser);
      const staleRead = MakaioBus.on(
        SessionStorageSubjects.get,
        (ctx) => {
          if (ctx.payload.sessionId === sessionId) ctx.setResult({ session: preDesignation });
        },
        { priority: 100 },
      );
      try {
        await emitAgentAdded(loser);
      } finally {
        staleRead();
      }

      const stored = (await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session;
      expect(stored?.leadAgentId).toBe('winner');
    });

    it('clears nothing when a non-lead agent is removed, and clears under CAS for the lead', async () => {
      const { sessionId, leadId, memberId } = await seedLeadAndMember();

      await MakaioBus.emit(SessionSubjects.agent.removed, { sessionId, agentId: memberId });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const afterMember = (await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session;
      expect(afterMember?.leadAgentId).toBe(leadId);
      expect((await MakaioBus.request(AgentStorageSubjects.get, { agentId: memberId })).agent?.status).toBe('disposed');

      await MakaioBus.emit(SessionSubjects.agent.removed, { sessionId, agentId: leadId });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const afterLead = (await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session;
      expect(afterLead?.leadAgentId).toBeUndefined();
      expect((await MakaioBus.request(AgentStorageSubjects.get, { agentId: leadId })).agent?.status).toBe('disposed');
    });

    it('gives up the removed agent’s claims cleanly, freeing the ownership key', async () => {
      const { sessionId, leadId } = await seedLeadAndMember();

      const claimed = await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
        machineId: 'machine-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        providerSessionId: 'provider-1',
        sessionId,
        agentId: leadId,
        claimToken: crypto.randomUUID(),
      });
      expect(claimed.outcome).toBe('claimed');

      await MakaioBus.emit(SessionSubjects.agent.removed, { sessionId, agentId: leadId });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // A removal is a deliberate stop, so the claim is released rather than
      // marked: the key is free for whoever attaches to that conversation next.
      const claims = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: 'machine-1' });
      expect(claims.claims).toEqual([]);
    });
  });
});
