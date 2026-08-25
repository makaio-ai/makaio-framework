// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 425 }] */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type IMakaioSession, type MakaioSessionAgent, type SessionMessage } from '@makaio/contracts';
import { buildRecoveryContext, recoverAgent, verifyAndRecoverAgents } from '../session-orchestrator-helpers.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../recovery-plan.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { RECOVERY_HELPERS_MACHINE_ID, RecoveryHelpersHarness } from './session-orchestrator.recovery.fixture.js';

/** Machine the authority is composed with, and therefore claims under. */
const MACHINE_ID = RECOVERY_HELPERS_MACHINE_ID;

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
  let harness: RecoveryHelpersHarness;

  beforeEach(async () => {
    harness = new RecoveryHelpersHarness();
    await harness.init();
    bus = harness.bus;
  });

  afterEach(() => {
    harness.destroy();
  });

  /**
   * Seed a session and one agent row the ownership seam can verify.
   * @param agentId - Agent identifier.
   * @param overrides - Agent field overrides.
   * @returns The stored agent record.
   */
  const seedAgent = (agentId: string, overrides?: Partial<MakaioSessionAgent>) => harness.seedAgent(agentId, overrides);

  /**
   * Answer rehydrates as the adapter does, recording every payload.
   * @returns The captured payloads, in order.
   */
  const captureRehydrates = () => harness.captureRehydrates();

  /**
   * Report every agent as dead, so the recovery path is the one under test.
   */
  const reportAgentsDead = () => harness.reportAgentsDead();

  it('verifyAndRecoverAgents returns usable agents and recovered IDs', async () => {
    const deadAgent = await seedAgent('dead-agent-1');
    const probes = reportAgentsDead();
    const payloads = captureRehydrates();

    const { usable, recoveredAgentIds, deferredAgentIds } = await verifyAndRecoverAgents(bus, [deadAgent], {
      cwd: '/test/path',
      model: 'test-model',
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: MACHINE_ID,
    });

    expect(payloads[0]).toMatchObject({
      adapterId: deadAgent.adapterId,
      agentId: deadAgent.agentId,
      cwd: '/test/path',
      model: 'test-model',
      // The service owns the row for a reserved recovery.
      callerOwnsAgentRow: true,
    });
    expect(probes).toEqual([
      { agentId: deadAgent.agentId, ownerInstanceId: harness.service.requireOwnershipInstanceId() },
    ]);
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

    await verifyAndRecoverAgents(bus, [deadAgent], { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN, machineId: MACHINE_ID });

    const stored = await bus.request(AgentStorageSubjects.get, { agentId: deadAgent.agentId });
    expect(stored.agent?.status).toBe('idle');
  });

  it('recoverAgent resolves the live adapter inside its exclusive attempt and preserves identity', async () => {
    const deadAgent = await seedAgent('dead-agent-given-adapter', { runtimeOwner: undefined });
    const payloads = captureRehydrates();

    const recovered = await recoverAgent(bus, deadAgent, {
      cwd: '/new/path',
      model: 'new-model',
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: MACHINE_ID,
    });

    expect(payloads[0]).toMatchObject({
      adapterId: 'live-claude-code',
      agentId: deadAgent.agentId,
      cwd: '/new/path',
      model: 'new-model',
    });
    expect(recovered.kind).toBe('recovered');
    if (recovered.kind !== 'recovered') throw new Error('expected a recovered agent');
    expect(recovered.agent.adapterId).toBe('live-claude-code');
    expect(recovered.agent).toBe(deadAgent); // Same reference - identity preserved
  });

  it('recoverAgent uses model override when provided', async () => {
    const deadAgent = await seedAgent('dead-agent-model-override', {
      sessionId: 'session-model-override',
      adapterId: 'test-adapter',
      model: 'old-model',
    });
    const payloads = captureRehydrates();

    await recoverAgent(bus, deadAgent, {
      model: 'new-model',
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: MACHINE_ID,
    });

    expect(payloads[0]?.model).toBe('new-model');
  });

  it('recoverAgent falls back to agent model when no override provided', async () => {
    const deadAgent = await seedAgent('dead-agent-fallback', {
      sessionId: 'session-fallback',
      adapterId: 'test-adapter',
      model: 'existing-model',
    });
    const payloads = captureRehydrates();

    await recoverAgent(bus, deadAgent, { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN, machineId: MACHINE_ID });

    expect(payloads[0]?.model).toBe('existing-model');
  });

  it('verifyAndRecoverAgents returns alive agents without recovery', async () => {
    const aliveAgent = await seedAgent('alive-agent', {
      sessionId: 'session-alive',
      adapterId: 'test-adapter',
      status: 'idle',
    });
    harness.addCleanup(
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
    harness.addCleanup(
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
      machineId: MACHINE_ID,
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
    harness.addCleanup(
      bus.on(AdapterSubjects.startAgent, (ctx) => {
        startAgentCalled = true;
        ctx.setResult({
          success: true,
          agentId: 'test-agent-id',
          adapterId: ctx.payload.adapterId,
          ownerInstanceId: ctx.payload.ownerInstanceId ?? 'unused-start-owner',
          adapterSessionId: 'test-adapter-session-id',
          sessionId: 'test-session-id',
        });
      }),
    );
    const payloads = captureRehydrates();

    await verifyAndRecoverAgents(bus, [deadAgent], { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN, machineId: MACHINE_ID });

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
