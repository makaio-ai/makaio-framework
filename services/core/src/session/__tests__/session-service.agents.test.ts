/**
 * Component tests for MakaioSessionService - Agent management.
 *
 * Tests the agent.added event handling: role assignment, lead agent
 * tracking, and lastActivityAt updates. Uses real bus requests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { registerMemoryAgentStorage } from '../storage/agent-memory-handler.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';

describe('MakaioSessionService - Agent Management', () => {
  let sessionService: MakaioSessionService;
  let sessionStorageCleanup: () => void;
  let agentStorageCleanup: () => void;
  let eventStorageCleanup: () => void;

  /**
   * Helper to persist an agent and emit agent.added event.
   * Simulates what the adapter does.
   * @param params - Agent parameters
   */
  async function addAgent(params: {
    sessionId: string;
    agentId: string;
    adapterId: string;
    adapterName: string;
    adapterSessionId: string;
    role?: 'lead' | 'member';
    model?: string;
    cwd?: string;
  }): Promise<void> {
    const now = Date.now();
    const role = params.role ?? 'lead';

    // Persist agent (simulates adapter)
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: params.agentId,
      agent: {
        agentId: params.agentId,
        adapterId: params.adapterId,
        adapterName: params.adapterName,
        sessionId: params.sessionId,
        adapterSessionId: params.adapterSessionId,
        role,
        status: 'idle',
        createdAt: now,
        lastActivityAt: now,
        model: params.model,
        cwd: params.cwd,
      },
    });

    // Emit event (triggers session service handler)
    await MakaioBus.emit(SessionSubjects.agent.added, {
      sessionId: params.sessionId,
      agentId: params.agentId,
      adapterId: params.adapterId,
      adapterName: params.adapterName,
      adapterSessionId: params.adapterSessionId,
      role, // Use computed role, not params.role
      model: params.model,
      cwd: params.cwd,
    });

    // Wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  beforeEach(async () => {
    // Register storage handlers BEFORE creating the service
    sessionStorageCleanup = registerMemorySessionStorage(MakaioBus);
    agentStorageCleanup = registerMemoryAgentStorage(MakaioBus);
    eventStorageCleanup = registerMemorySessionEventStorage(MakaioBus);

    // Create the service (constructor has no side effects)
    sessionService = new MakaioSessionService(MakaioBus);
    // Initialize the service (registers handlers)
    await sessionService.init();
  });

  afterEach(async () => {
    // Clean up in reverse order
    await sessionService.destroy();
    eventStorageCleanup();
    agentStorageCleanup();
    sessionStorageCleanup();
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
});
