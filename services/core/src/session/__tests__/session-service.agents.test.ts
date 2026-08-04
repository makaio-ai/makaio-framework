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
import { SessionOwnershipStorageSubjects, SessionSubjects } from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
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
    adapterSessionId: string;
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
