// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 425 }] */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionSubjects,
  type IMakaioSession,
  type MakaioSessionAgent,
  type SessionMessage,
} from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { buildRecoveryContext, recoverAgent, verifyAndRecoverAgents } from '../session-orchestrator-helpers.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../recovery-plan.js';
import { MakaioSessionService } from '../session-service.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { createTestAgent, registerMemorySessionBackends } from './shared.js';

/** Machine the authority is composed with, and therefore claims under. */
const MACHINE_ID = 'recovery-helpers-machine';

/**
 * Recovery helpers on a host that composes the ownership authority.
 *
 * Every recovery reserves before it dispatches, so these cases run against real
 * memory backends and the real service rather than a bare bus: without the
 * authority they would fail loudly, which is the contract's own statement about
 * a broken composition and is asserted elsewhere.
 */
describe('SessionOrchestrator recovery helpers', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let cleanups: Array<() => void> = [];

  beforeEach(async () => {
    bus = createBusInstance();
    cleanups = [...registerMemorySessionBackends(bus)];
    service = new MakaioSessionService(bus, { machineId: MACHINE_ID });
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Seed a session and one agent row the ownership seam can verify.
   * @param agentId - Agent identifier.
   * @param overrides - Agent field overrides.
   * @returns The stored agent record.
   */
  async function seedAgent(agentId: string, overrides?: Partial<MakaioSessionAgent>): Promise<MakaioSessionAgent> {
    const sessionId = overrides?.sessionId ?? 'session-recovery-1';
    await bus.request(SessionSubjects.create, { sessionId, machineId: MACHINE_ID });
    const agent = createTestAgent(agentId, {
      adapterName: 'claude-code',
      adapterId: 'stale-adapter-id',
      status: 'dead',
      role: 'lead',
      ...overrides,
      sessionId,
    });
    await bus.request(AgentStorageSubjects.set, { agentId, agent });
    return agent;
  }

  /**
   * Answer rehydrates as the adapter does, recording every payload.
   * @returns The captured payloads, in order.
   */
  function captureRehydrates(): Array<Record<string, unknown>> {
    const payloads: Array<Record<string, unknown>> = [];
    cleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        payloads.push(ctx.payload);
        ctx.setResult({ success: true });
      }),
    );
    return payloads;
  }

  /**
   * Report every agent as dead, so the recovery path is the one under test.
   */
  function reportAgentsDead(): void {
    cleanups.push(
      bus.on(AdapterSubjects.getAgent, (ctx) => {
        ctx.setResult({ agent: null });
      }),
    );
  }

  it('verifyAndRecoverAgents returns usable agents and recovered IDs', async () => {
    const deadAgent = await seedAgent('dead-agent-1');
    reportAgentsDead();
    const payloads = captureRehydrates();

    const { usable, recoveredAgentIds, deferredAgentIds } = await verifyAndRecoverAgents(bus, [deadAgent], {
      cwd: '/test/path',
      model: 'test-model',
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
    });

    expect(payloads[0]).toMatchObject({
      adapterId: deadAgent.adapterId,
      agentId: deadAgent.agentId,
      cwd: '/test/path',
      model: 'test-model',
      // The service owns the row for a reserved recovery.
      callerOwnsAgentRow: true,
    });
    expect(usable).toHaveLength(1);
    expect(usable[0].agentId).toBe(deadAgent.agentId); // Identity preserved
    expect(recoveredAgentIds.has(deadAgent.agentId)).toBe(true);
    expect(deferredAgentIds.size).toBe(0);
  });

  it('a recovered agent is committed back to idle by the service, not by the adapter', async () => {
    // Path B's status is caller-owned: the adapter writes nothing, and the
    // `starting → idle` transition is the service's compare-and-swap.
    const deadAgent = await seedAgent('dead-agent-commit');
    reportAgentsDead();
    captureRehydrates();

    await verifyAndRecoverAgents(bus, [deadAgent], { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN });

    const stored = await bus.request(AgentStorageSubjects.get, { agentId: deadAgent.agentId });
    expect(stored.agent?.status).toBe('idle');
  });

  it('recoverAgent dispatches to the adapter it was given and preserves identity', async () => {
    const deadAgent = await seedAgent('dead-agent-given-adapter');
    // Registered to prove it is never consulted: the caller owns the resolution
    // so the reservation it takes and the dispatch name one adapter instance.
    let resolveIdCalls = 0;
    cleanups.push(
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        resolveIdCalls += 1;
        ctx.setResult({ adapterId: 'resolved-by-the-callee' });
      }),
    );
    const payloads = captureRehydrates();

    const recovered = await recoverAgent(
      bus,
      deadAgent,
      { cwd: '/new/path', model: 'new-model', plan: FRESH_WITH_HISTORY_RECOVERY_PLAN },
      'current-adapter-id',
    );

    expect(payloads[0]).toMatchObject({
      adapterId: 'current-adapter-id',
      agentId: deadAgent.agentId,
      cwd: '/new/path',
      model: 'new-model',
    });
    expect(resolveIdCalls).toBe(0);
    expect(recovered.kind).toBe('recovered');
    if (recovered.kind !== 'recovered') throw new Error('expected a recovered agent');
    expect(recovered.agent.adapterId).toBe('current-adapter-id');
    expect(recovered.agent).toBe(deadAgent); // Same reference - identity preserved
  });

  it('recoverAgent uses model override when provided', async () => {
    const deadAgent = await seedAgent('dead-agent-model-override', {
      sessionId: 'session-model-override',
      adapterId: 'test-adapter',
      model: 'old-model',
    });
    const payloads = captureRehydrates();

    await recoverAgent(bus, deadAgent, { model: 'new-model', plan: FRESH_WITH_HISTORY_RECOVERY_PLAN }, 'test-adapter');

    expect(payloads[0]?.model).toBe('new-model');
  });

  it('recoverAgent falls back to agent model when no override provided', async () => {
    const deadAgent = await seedAgent('dead-agent-fallback', {
      sessionId: 'session-fallback',
      adapterId: 'test-adapter',
      model: 'existing-model',
    });
    const payloads = captureRehydrates();

    await recoverAgent(bus, deadAgent, { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN }, 'test-adapter');

    expect(payloads[0]?.model).toBe('existing-model');
  });

  it('verifyAndRecoverAgents returns alive agents without recovery', async () => {
    const aliveAgent = await seedAgent('alive-agent', {
      sessionId: 'session-alive',
      adapterId: 'test-adapter',
      status: 'idle',
    });
    cleanups.push(
      bus.on(AdapterSubjects.getAgent, (ctx) => {
        ctx.setResult({
          agent: {
            agentId: aliveAgent.agentId,
            sessionId: aliveAgent.sessionId,
            adapterSessionId: 'adapter-session-1',
          },
        });
      }),
    );

    const { usable, recoveredAgentIds } = await verifyAndRecoverAgents(bus, [aliveAgent], {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
    });

    expect(usable).toHaveLength(1);
    expect(usable[0]).toBe(aliveAgent);
    expect(recoveredAgentIds.size).toBe(0); // No recovery needed
  });

  it('mixed multi-agent: only dead agents are recovered, alive agents pass through', async () => {
    const deadAgent = await seedAgent('dead-agent', { sessionId: 'session-mixed', adapterId: 'test-adapter' });
    const aliveAgent = await seedAgent('alive-agent-mixed', {
      sessionId: 'session-mixed',
      adapterId: 'test-adapter',
      status: 'idle',
      role: 'member',
    });

    const getAgentCalls: string[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.getAgent, (ctx) => {
        getAgentCalls.push(ctx.payload.agentId);
        if (ctx.payload.agentId === 'dead-agent') {
          ctx.setResult({ agent: null });
          return;
        }
        ctx.setResult({
          agent: {
            agentId: aliveAgent.agentId,
            sessionId: aliveAgent.sessionId,
            adapterSessionId: 'adapter-session-1',
          },
        });
      }),
    );
    const payloads = captureRehydrates();

    const { usable, recoveredAgentIds } = await verifyAndRecoverAgents(bus, [deadAgent, aliveAgent], {
      cwd: '/test/path',
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
    });

    expect(usable).toHaveLength(2);
    expect(getAgentCalls).toEqual(['dead-agent', 'alive-agent-mixed']);
    expect(payloads.map((payload) => payload.agentId)).toEqual(['dead-agent']); // Only dead agent rehydrated
    expect(recoveredAgentIds.has('dead-agent')).toBe(true);
    expect(recoveredAgentIds.has('alive-agent-mixed')).toBe(false);
  });

  it('dead agent recovery calls rehydrateAgent not startAgent', async () => {
    const deadAgent = await seedAgent('dead-agent-no-start', { sessionId: 'session-no-start' });
    reportAgentsDead();

    let startAgentCalled = false;
    cleanups.push(
      bus.on(AdapterSubjects.startAgent, (ctx) => {
        startAgentCalled = true;
        ctx.setResult({
          success: true,
          agentId: 'test-agent-id',
          adapterId: ctx.payload.adapterId,
          adapterSessionId: 'test-adapter-session-id',
          sessionId: 'test-session-id',
        });
      }),
    );
    const payloads = captureRehydrates();

    await verifyAndRecoverAgents(bus, [deadAgent], { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN });

    expect(startAgentCalled).toBe(false);
    expect(payloads).toHaveLength(1);
  });
});

/**
 * History assembly, which touches no ownership at all and therefore runs on a
 * bare bus: registering the memory backends here would answer the very storage
 * subjects these cases stub.
 */
describe('buildRecoveryContext', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
  });

  it('builds messageHistory from stored messages', async () => {
    const session: IMakaioSession = {
      sessionId: 'session-ctx-1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: 'active',
      agents: [],
      targetWorkingDirectory: '/test/dir',
    };

    // Mock SessionStorageSubjects.get - returns the session
    bus.on(SessionStorageSubjects.get, (ctx) => {
      ctx.setResult({
        session: ctx.payload.sessionId === session.sessionId ? session : null,
      });
    });

    // Mock SessionEventStorageSubjects.getEvents - returns events with message references
    bus.on(SessionEventStorageSubjects.getEvents, (ctx) => {
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
    bus.on(MessageStorageSubjects.get, (ctx) => {
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

    const result = await buildRecoveryContext(bus, session);

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
});
