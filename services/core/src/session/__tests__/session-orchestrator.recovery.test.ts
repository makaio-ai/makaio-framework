// NOTE: do NOT change lint limits without explicit human approval
/* eslint max-lines: ["error", { "max": 425 }] */
import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type IMakaioSession, type MakaioSessionAgent, type SessionMessage } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { buildRecoveryContext, recoverAgent, verifyAndRecoverAgents } from '../session-orchestrator-helpers.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';
import { MessageStorageSubjects } from '../messages/namespace.js';

function createSessionWithDeadAgent(): { session: IMakaioSession; deadAgent: MakaioSessionAgent } {
  const deadAgent: MakaioSessionAgent = {
    agentId: 'dead-agent-1',
    adapterId: 'stale-adapter-id',
    adapterName: 'claude-code',
    sessionId: 'session-recovery-1',
    status: 'dead',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    role: 'lead',
  };

  const session: IMakaioSession = {
    sessionId: 'session-recovery-1',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    status: 'active',
    agents: [deadAgent],
    leadAgentId: deadAgent.agentId,
  };

  return { session, deadAgent };
}

describe('SessionOrchestrator recovery helpers', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('verifyAndRecoverAgents returns verified agents and recovered IDs', async () => {
    const { deadAgent } = createSessionWithDeadAgent();
    let rehydratePayload: { adapterId: string; agentId: string; cwd?: string; model?: string } | undefined;

    MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      expect(ctx.payload.agentId).toBe(deadAgent.agentId);
      ctx.setResult({ agent: null }); // Agent is dead
    });

    MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydratePayload = ctx.payload;
      ctx.setResult({}); // Success implicit
    });

    const { verifiedAgents, recoveredAgentIds } = await verifyAndRecoverAgents(MakaioBus, [deadAgent], {
      cwd: '/test/path',
      model: 'test-model',
    });

    expect(rehydratePayload).toMatchObject({
      adapterId: deadAgent.adapterId,
      agentId: deadAgent.agentId,
      cwd: '/test/path',
      model: 'test-model',
    });
    expect(verifiedAgents).toHaveLength(1);
    expect(verifiedAgents[0].agentId).toBe(deadAgent.agentId); // Identity preserved
    expect(recoveredAgentIds.has(deadAgent.agentId)).toBe(true);
  });

  it('recoverAgent swaps connector and preserves identity', async () => {
    const { deadAgent } = createSessionWithDeadAgent();
    let rehydratePayload: { adapterId: string; agentId: string; cwd?: string; model?: string } | undefined;

    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      expect(ctx.payload.adapterName).toBe(deadAgent.adapterName);
      ctx.setResult({ adapterId: 'current-adapter-id' });
    });

    MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydratePayload = ctx.payload;
      ctx.setResult({}); // Success implicit
    });

    const recovered = await recoverAgent(MakaioBus, deadAgent, {
      cwd: '/new/path',
      model: 'new-model',
    });

    expect(rehydratePayload).toMatchObject({
      adapterId: 'current-adapter-id',
      agentId: deadAgent.agentId,
      cwd: '/new/path',
      model: 'new-model',
    });
    expect(recovered.adapterId).toBe('current-adapter-id');
    expect(recovered).toBe(deadAgent); // Same reference - identity preserved
  });

  it('buildRecoveryContext builds messageHistory from stored messages', async () => {
    const session: IMakaioSession = {
      sessionId: 'session-ctx-1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'active',
      agents: [],
      targetWorkingDirectory: '/test/dir',
    };

    // Mock SessionStorageSubjects.get - returns the session
    MakaioBus.on(SessionStorageSubjects.get, (ctx) => {
      ctx.setResult({
        session: ctx.payload.sessionId === session.sessionId ? session : null,
      });
    });

    // Mock SessionEventStorageSubjects.getEvents - returns events with message references
    MakaioBus.on(SessionEventStorageSubjects.getEvents, (ctx) => {
      ctx.setResult({
        events: [
          {
            eventId: 'evt-1',
            sessionId: session.sessionId,
            type: 'message' as const,
            payload: {
              messageId: 'msg-user-1',
              turnId: 'turn-1',
              role: 'user' as const,
            },
            timestamp: Date.now() - 2000,
          },
          {
            eventId: 'evt-2',
            sessionId: session.sessionId,
            type: 'message' as const,
            payload: {
              messageId: 'msg-assistant-1',
              turnId: 'turn-1',
              role: 'assistant' as const,
            },
            timestamp: Date.now() - 1000,
          },
        ],
        nextCursor: null,
      });
    });

    // Mock MessageStorageSubjects.get - returns actual messages
    MakaioBus.on(MessageStorageSubjects.get, (ctx) => {
      const messages: Record<string, SessionMessage> = {
        'msg-user-1': {
          messageId: 'msg-user-1',
          sessionId: session.sessionId,
          turnId: 'turn-1',
          role: 'user',
          contentText: 'Hello',
          blocks: [{ type: 'text', content: 'Hello' }],
          timestamp: Date.now() - 2000,
        },
        'msg-assistant-1': {
          messageId: 'msg-assistant-1',
          sessionId: session.sessionId,
          turnId: 'turn-1',
          role: 'assistant',
          contentText: 'Hi there',
          blocks: [{ type: 'text', content: 'Hi there' }],
          timestamp: Date.now() - 1000,
        },
      };

      ctx.setResult({
        message: messages[ctx.payload.messageId] ?? null,
      });
    });

    const result = await buildRecoveryContext(MakaioBus, session);

    expect(result.isFirstTurn).toBe(true);
    expect(result.messageHistory).toBeDefined();
    expect(result.messageHistory).toHaveLength(2);
    expect(result.messageHistory?.[0].role).toBe('user');
    expect(result.messageHistory?.[0].blocks).toHaveLength(1);
    expect((result.messageHistory?.[0].blocks as Array<{ type: string; content: string }>)[0]).toMatchObject({
      type: 'text',
      content: 'Hello',
    });
    expect(result.messageHistory?.[1].role).toBe('assistant');
    expect(result.messageHistory?.[1].blocks).toHaveLength(1);
    expect((result.messageHistory?.[1].blocks as Array<{ type: string; content: string }>)[0]).toMatchObject({
      type: 'text',
      content: 'Hi there',
    });
  });

  it('recoverAgent uses model override when provided', async () => {
    const deadAgent: MakaioSessionAgent = {
      agentId: 'dead-agent-model-override',
      adapterId: 'test-adapter',
      adapterName: 'claude-code',
      sessionId: 'session-1',
      status: 'dead',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      role: 'lead',
      model: 'old-model',
    };

    let rehydratePayload: { adapterId: string; agentId: string; cwd?: string; model?: string } | undefined;

    MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydratePayload = ctx.payload;
      ctx.setResult({});
    });

    await recoverAgent(MakaioBus, deadAgent, { model: 'new-model' });

    expect(rehydratePayload?.model).toBe('new-model');
  });

  it('recoverAgent falls back to agent model when no override provided', async () => {
    const deadAgent: MakaioSessionAgent = {
      agentId: 'dead-agent-fallback',
      adapterId: 'test-adapter',
      adapterName: 'claude-code',
      sessionId: 'session-1',
      status: 'dead',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      role: 'lead',
      model: 'existing-model',
    };

    let rehydratePayload: { adapterId: string; agentId: string; cwd?: string; model?: string } | undefined;

    MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydratePayload = ctx.payload;
      ctx.setResult({});
    });

    await recoverAgent(MakaioBus, deadAgent, {});

    expect(rehydratePayload?.model).toBe('existing-model');
  });

  it('verifyAndRecoverAgents returns alive agents without recovery', async () => {
    const aliveAgent: MakaioSessionAgent = {
      agentId: 'alive-agent',
      adapterId: 'test-adapter',
      adapterName: 'claude-code',
      sessionId: 'session-1',
      status: 'idle',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      role: 'lead',
    };

    MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      ctx.setResult({
        agent: {
          agentId: aliveAgent.agentId,
          sessionId: aliveAgent.sessionId,
          adapterSessionId: 'adapter-session-1',
        },
      }); // Agent is alive
    });

    const { verifiedAgents, recoveredAgentIds } = await verifyAndRecoverAgents(MakaioBus, [aliveAgent], {});

    expect(verifiedAgents).toHaveLength(1);
    expect(verifiedAgents[0]).toBe(aliveAgent);
    expect(recoveredAgentIds.size).toBe(0); // No recovery needed
  });

  it('mixed multi-agent: only dead agents are recovered, alive agents pass through', async () => {
    const deadAgent: MakaioSessionAgent = {
      agentId: 'dead-agent',
      adapterId: 'test-adapter',
      adapterName: 'claude-code',
      sessionId: 'session-1',
      status: 'dead',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      role: 'lead',
    };

    const aliveAgent: MakaioSessionAgent = {
      agentId: 'alive-agent',
      adapterId: 'test-adapter',
      adapterName: 'claude-code',
      sessionId: 'session-1',
      status: 'idle',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      role: 'member',
    };

    const getAgentCalls: string[] = [];
    MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      getAgentCalls.push(ctx.payload.agentId);
      // Dead agent returns null, alive agent returns agent info
      if (ctx.payload.agentId === 'dead-agent') {
        ctx.setResult({ agent: null });
      } else {
        ctx.setResult({
          agent: {
            agentId: aliveAgent.agentId,
            sessionId: aliveAgent.sessionId,
            adapterSessionId: 'adapter-session-1',
          },
        });
      }
    });

    const rehydrateCalls: string[] = [];
    MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCalls.push(ctx.payload.agentId);
      ctx.setResult({});
    });

    const { verifiedAgents, recoveredAgentIds } = await verifyAndRecoverAgents(MakaioBus, [deadAgent, aliveAgent], {
      cwd: '/test/path',
    });

    expect(verifiedAgents).toHaveLength(2);
    expect(getAgentCalls).toEqual(['dead-agent', 'alive-agent']);
    expect(rehydrateCalls).toEqual(['dead-agent']); // Only dead agent rehydrated
    expect(recoveredAgentIds.has('dead-agent')).toBe(true);
    expect(recoveredAgentIds.has('alive-agent')).toBe(false);
  });

  it('dead agent recovery calls rehydrateAgent not startAgent', async () => {
    const { deadAgent } = createSessionWithDeadAgent();

    let startAgentCalled = false;
    let rehydrateAgentCalled = false;

    MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      ctx.setResult({ agent: null }); // Agent is dead
    });

    MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
      startAgentCalled = true;
      ctx.setResult({
        success: true,
        agentId: 'test-agent-id',
        adapterId: ctx.payload.adapterId,
        adapterSessionId: 'test-adapter-session-id',
        sessionId: 'test-session-id',
      });
    });

    MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateAgentCalled = true;
      ctx.setResult({});
    });

    await verifyAndRecoverAgents(MakaioBus, [deadAgent], {});

    expect(startAgentCalled).toBe(false);
    expect(rehydrateAgentCalled).toBe(true);
  });
});
