import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { registerMemoryAgentStorage } from '../storage/agent-memory-handler.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { MakaioSessionService } from '../session-service.js';
import { createTestAgent } from './shared.js';

/**
 * Registers shared adapter runtime stubs for tests that exercise the
 * rehydration path (native locality confirmed).
 *
 * Registers:
 * - `adapterRuntime.getMachineId` → returns `machineId`
 * - `adapter.getCapabilities` → declares `session:resume`
 * - `adapterRuntime.resolveId` → returns `current-{adapterName}`
 * @param bus - Test bus instance
 * @param machineId - Machine identity to return from the mock handler
 * @returns Cleanup function to remove registered handlers
 */
function registerRuntimeIdentityAndCapabilities(bus: IMakaioBus, machineId: string): () => void {
  const unsubs = [
    bus.on(AdapterRuntimeSubjects.getMachineId, (ctx) => {
      ctx.setResult({ machineId });
    }),
    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
    }),
    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
    }),
  ];
  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}

describe('MakaioSessionService - restartAgents', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let agentStorageCleanup: () => void;
  let sessionStorageCleanup: () => void;

  const MACHINE_ID = 'test-machine';

  beforeEach(async () => {
    bus = createBusInstance();
    agentStorageCleanup = registerMemoryAgentStorage(bus);
    sessionStorageCleanup = registerMemorySessionStorage(bus);
    service = new MakaioSessionService(bus);
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    sessionStorageCleanup();
    agentStorageCleanup();
  });

  it('rehydrates each persisted session agent through adapter.rehydrateAgent', async () => {
    const sessionId = 'session-restart-success';
    const runtimeCleanup = registerRuntimeIdentityAndCapabilities(bus, MACHINE_ID);
    await createSessionWithLocality(bus, sessionId, MACHINE_ID, 'provider-session-xyz');
    await persistAgent(bus, 'agent-one', sessionId, {
      adapterId: 'stale-adapter-one',
      adapterName: 'test-adapter',
      cwd: '/workspace/one',
      model: 'model-one',
    });
    await persistAgent(bus, 'agent-two', sessionId, {
      adapterId: 'stale-adapter-two',
      adapterName: 'test-adapter',
      cwd: '/workspace/two',
      model: 'model-two',
    });

    const rehydrateRequests: Array<{
      adapterId: string;
      agentId: string;
      cwd?: string;
      model?: string;
      adapterSessionId?: string;
      resumeAdapterSessionId?: string;
    }> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId });

    expect(result).toEqual({
      sessionId,
      results: [
        { agentId: 'agent-one', adapterId: 'current-test-adapter', success: true },
        { agentId: 'agent-two', adapterId: 'current-test-adapter', success: true },
      ],
    });
    expect(rehydrateRequests).toHaveLength(2);
    expect(rehydrateRequests[0]).toEqual(
      expect.objectContaining({
        agentId: 'agent-one',
        resumeAdapterSessionId: 'native-agent-one',
      }),
    );
    expect(rehydrateRequests[1]).toEqual(
      expect.objectContaining({
        agentId: 'agent-two',
        resumeAdapterSessionId: 'native-agent-two',
      }),
    );

    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-one' });
    expect(agent?.adapterId).toBe('current-test-adapter');
    runtimeCleanup();
  });

  it('leaves rehydrate-side storage mutations intact', async () => {
    const sessionId = 'session-restart-storage-owner';
    const runtimeCleanup = registerRuntimeIdentityAndCapabilities(bus, MACHINE_ID);
    await createSessionWithLocality(bus, sessionId, MACHINE_ID, 'provider-session-xyz');
    await persistAgent(bus, 'agent-storage-owner', sessionId, {
      adapterId: 'stale-adapter',
      adapterName: 'test-adapter',
      status: 'dead',
    });

    bus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      await bus.request(AgentStorageSubjects.updateStatus, {
        agentId: ctx.payload.agentId,
        status: 'idle',
      });
      ctx.setResult({});
    });
    let setCallsDuringRestart = 0;
    bus.on(AgentStorageSubjects.set, (ctx) => {
      setCallsDuringRestart += 1;
      ctx.setResult({ success: true });
    });

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId });
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-storage-owner' });

    expect(result.results).toEqual([
      { agentId: 'agent-storage-owner', adapterId: 'current-test-adapter', success: true },
    ]);
    expect(agent?.adapterId).toBe('current-test-adapter');
    expect(agent?.status).toBe('idle');
    expect(setCallsDuringRestart).toBe(0);
    runtimeCleanup();
  });

  it('reports per-agent failures without aborting remaining rehydrates', async () => {
    const sessionId = 'session-restart-failure';
    const runtimeCleanup = registerRuntimeIdentityAndCapabilities(bus, MACHINE_ID);
    await createSessionWithLocality(bus, sessionId, MACHINE_ID, 'provider-session-xyz');
    await persistAgent(bus, 'agent-fails', sessionId, {
      adapterId: 'adapter-fails',
      adapterName: 'test-adapter',
    });
    await persistAgent(bus, 'agent-ok', sessionId, {
      adapterId: 'adapter-ok',
      adapterName: 'test-adapter',
    });

    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      if (ctx.payload.agentId === 'agent-fails') {
        throw new Error('adapter refused rehydrate');
      }
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId });

    expect(result).toEqual({
      sessionId,
      results: [
        {
          agentId: 'agent-fails',
          adapterId: 'adapter-fails',
          success: false,
          error: 'adapter refused rehydrate',
        },
        { agentId: 'agent-ok', adapterId: 'current-test-adapter', success: true },
      ],
    });
    runtimeCleanup();
  });
});

describe('MakaioSessionService - restartAgents with locality', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let agentStorageCleanup: () => void;
  let sessionStorageCleanup: () => void;

  beforeEach(async () => {
    bus = createBusInstance();
    agentStorageCleanup = registerMemoryAgentStorage(bus);
    sessionStorageCleanup = registerMemorySessionStorage(bus);
    service = new MakaioSessionService(bus);
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    sessionStorageCleanup();
    agentStorageCleanup();
  });

  it('passes resumeAdapterSessionId when locality evaluates as native', async () => {
    const sessionId = 'session-native-restart';
    const machineId = 'local-machine-abc';
    await createSessionWithLocality(bus, sessionId, machineId, 'provider-session-xyz');
    await persistAgent(bus, 'agent-native', sessionId, {
      adapterId: 'adapter-native',
      adapterName: 'test-adapter',
      cwd: '/workspace',
      model: 'test-model',
    });

    // Register adapter capability: session:resume
    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
    });
    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
    });

    const rehydrateRequests: Array<Record<string, unknown>> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId,
      machineId,
    });

    expect(result.results).toEqual([{ agentId: 'agent-native', adapterId: 'current-test-adapter', success: true }]);
    expect(rehydrateRequests).toHaveLength(1);
    expect(rehydrateRequests[0]).toEqual(
      expect.objectContaining({
        agentId: 'agent-native',
        resumeAdapterSessionId: 'native-agent-native',
      }),
    );
  });

  it('defers rehydration for degraded locality (foreign machine)', async () => {
    const sessionId = 'session-foreign-restart';
    await createSessionWithLocality(bus, sessionId, 'remote-machine-xyz', 'provider-session-xyz');
    await persistAgent(bus, 'agent-foreign', sessionId, {
      adapterId: 'adapter-foreign',
      adapterName: 'test-adapter',
    });

    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
    });

    const rehydrateRequests: Array<Record<string, unknown>> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId,
      machineId: 'local-machine-abc',
    });

    // Agent is reported as success (intact in storage, will be lazily recovered)
    // but NO rehydrate call was made.
    expect(result.results).toEqual([{ agentId: 'agent-foreign', adapterId: 'adapter-foreign', success: true }]);
    expect(rehydrateRequests).toHaveLength(0);
  });

  it('defers rehydration when adapter does not support session:resume', async () => {
    const sessionId = 'session-no-resume-restart';
    const machineId = 'local-machine-abc';
    await createSessionWithLocality(bus, sessionId, machineId, 'provider-session-xyz');
    await persistAgent(bus, 'agent-no-resume', sessionId, {
      adapterId: 'adapter-no-resume',
      adapterName: 'test-adapter',
    });

    // Adapter does NOT declare session:resume
    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: [], nativeTools: [] });
    });

    const rehydrateRequests: Array<Record<string, unknown>> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId,
      machineId,
    });

    // Degraded because adapter doesn't support resume — deferred.
    expect(result.results).toEqual([{ agentId: 'agent-no-resume', adapterId: 'adapter-no-resume', success: true }]);
    expect(rehydrateRequests).toHaveLength(0);
  });

  it('resolves runtime identity when payload machineId is omitted', async () => {
    const sessionId = 'session-runtime-identity';
    const runtimeMachineId = 'runtime-resolved-machine';
    await createSessionWithLocality(bus, sessionId, runtimeMachineId, 'provider-session-abc');
    await persistAgent(bus, 'agent-runtime', sessionId, {
      adapterId: 'adapter-runtime',
      adapterName: 'test-adapter',
      cwd: '/workspace',
      model: 'test-model',
    });

    // Register runtime identity + adapter capability
    bus.on(AdapterRuntimeSubjects.getMachineId, (ctx) => {
      ctx.setResult({ machineId: runtimeMachineId });
    });
    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
    });
    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
    });

    const rehydrateRequests: Array<Record<string, unknown>> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    // No machineId in payload — handler resolves it from runtime identity
    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId,
    });

    expect(result.results).toEqual([{ agentId: 'agent-runtime', adapterId: 'current-test-adapter', success: true }]);
    expect(rehydrateRequests).toHaveLength(1);
    expect(rehydrateRequests[0]).toEqual(
      expect.objectContaining({
        agentId: 'agent-runtime',
        resumeAdapterSessionId: 'native-agent-runtime',
      }),
    );
  });

  it('defers all agents when identity resolution is unavailable', async () => {
    const sessionId = 'session-no-identity';
    await createSessionWithLocality(bus, sessionId, 'some-machine', 'provider-session-xyz');
    await persistAgent(bus, 'agent-no-identity', sessionId, {
      adapterId: 'adapter-no-identity',
      adapterName: 'test-adapter',
    });

    // No getMachineId handler registered — identity resolution unavailable.
    // Register getCapabilities so the test isolates the identity-unavailable
    // path (adapter would support resume if identity were known).
    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
    });

    const rehydrateRequests: Array<Record<string, unknown>> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    // No machineId in payload, no getMachineId handler → degrades to
    // missing-machine-id → deferred (never empty-context rehydration).
    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId,
    });

    expect(result.results).toEqual([{ agentId: 'agent-no-identity', adapterId: 'adapter-no-identity', success: true }]);
    // Deferred — no rehydrate call issued.
    expect(rehydrateRequests).toHaveLength(0);
  });

  it('two agents with distinct adapterSessionId each rehydrate with their own provider session id', async () => {
    const sessionId = 'session-multi-agent-native';
    const machineId = 'local-machine-multi';
    // Session-level adapterSessionId belongs to the lead agent and must NOT be
    // used for other agents. Each agent carries its own provider-confirmed ID.
    await createSessionWithLocality(bus, sessionId, machineId, 'lead-provider-session');
    await persistAgent(bus, 'agent-lead', sessionId, {
      adapterId: 'adapter-lead',
      adapterName: 'test-adapter',
      cwd: '/workspace',
      model: 'test-model',
      adapterSessionId: 'provider-session-lead',
    });
    await persistAgent(bus, 'agent-member', sessionId, {
      adapterId: 'adapter-member',
      adapterName: 'test-adapter',
      cwd: '/workspace',
      model: 'test-model',
      adapterSessionId: 'provider-session-member',
    });

    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
    });
    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
    });

    const rehydrateRequests: Array<{ agentId: string; resumeAdapterSessionId?: string }> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push({
        agentId: ctx.payload.agentId,
        resumeAdapterSessionId: ctx.payload.resumeAdapterSessionId,
      });
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId,
      machineId,
    });

    expect(result.results).toEqual([
      { agentId: 'agent-lead', adapterId: 'current-test-adapter', success: true },
      { agentId: 'agent-member', adapterId: 'current-test-adapter', success: true },
    ]);
    expect(rehydrateRequests).toHaveLength(2);
    // Each agent resumes against its own provider conversation, never the lead's.
    expect(rehydrateRequests[0]).toEqual({
      agentId: 'agent-lead',
      resumeAdapterSessionId: 'provider-session-lead',
    });
    expect(rehydrateRequests[1]).toEqual({
      agentId: 'agent-member',
      resumeAdapterSessionId: 'provider-session-member',
    });
  });

  it('defers native-verdict agent that has no adapterSessionId to lazy recovery', async () => {
    const sessionId = 'session-native-no-agent-id';
    const machineId = 'local-machine-no-agent-id';
    await createSessionWithLocality(bus, sessionId, machineId, 'lead-provider-session');
    // Agent was never confirmed by the provider — adapterSessionId is absent.
    await persistAgent(bus, 'agent-unconfirmed', sessionId, {
      adapterId: 'adapter-unconfirmed',
      adapterName: 'test-adapter',
      cwd: '/workspace',
      model: 'test-model',
      adapterSessionId: undefined,
    });

    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
    });
    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
    });

    const rehydrateRequests: Array<Record<string, unknown>> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId,
      machineId,
    });

    // Success — agent record is intact and will be lazily recovered on first send.
    expect(result.results).toEqual([{ agentId: 'agent-unconfirmed', adapterId: 'adapter-unconfirmed', success: true }]);
    // Deferred — no rehydrate call must be issued.
    expect(rehydrateRequests).toHaveLength(0);
  });

  it('payload machineId overrides runtime identity', async () => {
    const sessionId = 'session-override';
    const payloadMachineId = 'payload-machine';
    await createSessionWithLocality(bus, sessionId, payloadMachineId, 'provider-session-override');
    await persistAgent(bus, 'agent-override', sessionId, {
      adapterId: 'adapter-override',
      adapterName: 'test-adapter',
    });

    // Runtime returns a DIFFERENT machine ID — payload should win.
    bus.on(AdapterRuntimeSubjects.getMachineId, (ctx) => {
      ctx.setResult({ machineId: 'wrong-runtime-machine' });
    });
    bus.on(AdapterSubjects.getCapabilities, (ctx) => {
      ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
    });
    bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
    });

    const rehydrateRequests: Array<Record<string, unknown>> = [];
    bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateRequests.push(ctx.payload);
      ctx.setResult({});
    });

    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId,
      machineId: payloadMachineId,
    });

    // Payload machineId matches session machineId → native locality → rehydrated
    expect(result.results).toEqual([{ agentId: 'agent-override', adapterId: 'current-test-adapter', success: true }]);
    expect(rehydrateRequests).toHaveLength(1);
    expect(rehydrateRequests[0]).toEqual(
      expect.objectContaining({
        resumeAdapterSessionId: 'native-agent-override',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Create a session in storage with adapterSessionId and machineId fields.
 * @param bus - Test bus instance
 * @param sessionId - Session identifier
 * @param machineId - Machine identity for locality
 * @param adapterSessionId - Provider session ID for native resume
 */
async function createSessionWithLocality(
  bus: IMakaioBus,
  sessionId: string,
  machineId: string,
  adapterSessionId: string,
): Promise<void> {
  await bus.request(SessionSubjects.create, { sessionId, machineId });
  // Stamp adapterSessionId onto the session (normally set by agent start).
  const { session } = await bus.request(SessionSubjects.get, { sessionId });
  if (!session) throw new Error('Session not found after create');
  await bus.request(SessionStorageSubjects.set, {
    sessionId,
    session: { ...session, adapterSessionId },
  });
}

/**
 * Persist an agent record in agent storage.
 *
 * By default the agent is stamped with an `adapterSessionId` of the form
 * `native-{agentId}` to simulate a provider-confirmed session from a prior
 * run. Pass `adapterSessionId: undefined` explicitly to create an agent that
 * was never confirmed by the provider (e.g., an agent that was never started).
 * @param bus - Test bus instance
 * @param agentId - Agent identifier
 * @param sessionId - Owning session
 * @param overrides - Agent field overrides
 */
async function persistAgent(
  bus: IMakaioBus,
  agentId: string,
  sessionId: string,
  overrides: {
    adapterId: string;
    adapterName: string;
    cwd?: string;
    model?: string;
    status?: MakaioSessionAgent['status'];
    adapterSessionId?: string;
  },
): Promise<void> {
  const { adapterSessionId: explicitAdapterSessionId, ...rest } = overrides;
  // Use explicit value when provided; default to `native-${agentId}` to
  // simulate a provider-confirmed session from a prior run. Callers that pass
  // `adapterSessionId: undefined` get an agent with no provider session ID.
  const resolvedAdapterSessionId = 'adapterSessionId' in overrides ? explicitAdapterSessionId : `native-${agentId}`;
  await bus.request(AgentStorageSubjects.set, {
    agentId,
    agent: createTestAgent(agentId, {
      sessionId,
      role: agentId.endsWith('one') || agentId.endsWith('ok') ? 'lead' : 'member',
      ...rest,
      ...(resolvedAdapterSessionId !== undefined && { adapterSessionId: resolvedAdapterSessionId }),
    }),
  });
}
