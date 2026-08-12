/**
 * Tests for the ownership authority as a **hard** dependency of the start paths
 * that already reserve — the fresh lead start (Path A) and the restart handler.
 *
 * Everything runs against the real memory backends through a real bus, and the
 * only thing a case varies is what the *host* composed: an authority that is
 * absent, or an authority that is present without a machine identity. Those two
 * conditions used to be conflated into one degrade, and the whole point of the
 * matrix is that they are not the same — an absent authority is a broken
 * composition and must fail loudly, while a missing machine identity is a
 * modeled answer a keyless reservation never even asks for.
 *
 * The remaining arms of the matrix — the adapter-owned resume start, the
 * reserved rehydrate and the reserved attach — arrive with the paths that take
 * those reservations and are gated there; none of them exists yet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type AdapterSessionClaimRecord,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { registerRestartAgentsHandler } from '../handlers/restart-agents.js';
import { startLeadAgent } from '../handlers/lead-start.js';
import { KEYLESS_DESIGNATION_KEY } from '../ownership/lead-designation.js';
import { MakaioSessionService } from '../session-service.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { registerCallerSettlementAckHandler } from '../testing/caller-owned-adapter-stub.js';
import { createTestAgent, createTestSession, registerMemorySessionBackends } from './shared.js';

const MACHINE_ID = 'hard-dependency-machine';
const ADAPTER_NAME = 'test-adapter';
const ADAPTER_ID = 'test-adapter-instance';
const RESERVE_START_SUBJECT = 'session.ownership.reserveStart';

describe('the ownership authority is a hard dependency of every reserving start path', () => {
  let bus: IMakaioBus;
  let cleanups: Array<() => void>;
  let service: MakaioSessionService | undefined;
  let dispatchedStarts: string[];
  let dispatchedRehydrates: string[];
  /**
   * Provider session the stubbed adapter reports, or `null` for an idle start
   * that reports none — which is also the only Path-A shape that settles
   * nothing, and therefore the one a host with no machine identity can finish.
   */
  let startedProviderSessionId: string | null;

  beforeEach(() => {
    bus = createBusInstance();
    dispatchedStarts = [];
    dispatchedRehydrates = [];
    startedProviderSessionId = 'provider-1';
    cleanups = [
      ...registerMemorySessionBackends(bus),
      registerCallerSettlementAckHandler(bus),
      bus.on(AdapterSubjects.startAgent, (ctx) => {
        const agentId = ctx.payload.agentId ?? 'adapter-minted-agent';
        dispatchedStarts.push(agentId);
        ctx.setResult({
          success: true as const,
          agentId,
          adapterId: ctx.payload.adapterId,
          sessionId: ctx.payload.sessionId ?? 'unexpected-session',
          ...(startedProviderSessionId !== null && { adapterSessionId: startedProviderSessionId }),
          ownerInstanceId: ctx.payload.ownerInstanceId ?? 'hard-dependency-owner',
          settlementAckToken: `hard-dependency-start-${agentId}`,
        });
      }),
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        dispatchedRehydrates.push(ctx.payload.agentId);
        ctx.setResult({
          success: true,
          ownerInstanceId: ctx.payload.ownerInstanceId,
          settlementAckToken: `hard-dependency-rehydrate-${ctx.payload.agentId}`,
        });
      }),
    ];
  });

  afterEach(() => {
    service?.destroy();
    service = undefined;
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Compose the ownership authority this host reserves from.
   * @param machineId - Identity the authority owns claims under, or `undefined`
   *   for the host that has none — the condition case 86 separates from an
   *   absent authority.
   */
  async function composeAuthority(machineId?: string): Promise<MakaioSessionService> {
    service = new MakaioSessionService(bus, { ...(machineId !== undefined && { machineId }) });
    await service.init();
    return service;
  }

  /**
   * Persist an empty session row directly.
   *
   * Written through storage rather than `session.create`, because the hosts
   * under test are precisely the ones that may not have composed the session
   * service at all.
   * @param sessionId - Session to create.
   * @param overrides - Fields the case needs on the row.
   */
  async function seedSession(sessionId: string, overrides?: { adapterSessionId?: string }): Promise<void> {
    await bus.request(SessionStorageSubjects.set, {
      sessionId,
      session: createTestSession(sessionId, { machineId: MACHINE_ID, ...overrides }),
    });
  }

  /**
   * Persist one resumable agent for the restart handler to plan for.
   * @param agentId - Agent to persist.
   * @param sessionId - Session the agent belongs to.
   */
  async function seedResumableAgent(agentId: string, sessionId: string): Promise<void> {
    await bus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        role: 'lead',
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        adapterSessionId: `native-${agentId}`,
      }),
    });
  }

  /**
   * Register the runtime stubs a native-resume plan needs to be reachable.
   *
   * Without them the restart handler defers every agent to history injection
   * and never reaches a reservation, which would make the case pass for the
   * wrong reason.
   */
  function registerResumableRuntime(): void {
    cleanups.push(
      bus.on(AdapterRuntimeSubjects.getMachineId, (ctx) => {
        ctx.setResult({ machineId: MACHINE_ID });
      }),
      bus.on(AdapterSubjects.getCapabilities, (ctx) => {
        ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
      }),
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: ADAPTER_ID });
      }),
      bus.on(AdapterRuntimeSubjects.resolveLiveIdentity, (ctx) => {
        ctx.setResult({
          adapterId: ADAPTER_ID,
          adapterName: ctx.payload.adapterName,
          machineId: ctx.payload.machineId,
          ownerInstanceId: service?.requireOwnershipInstanceId() ?? 'hard-dependency-owner',
        });
      }),
    );
  }

  /**
   * List every claim held on one machine.
   * @param machineId - Machine whose claims are read.
   * @returns The claims, in storage order.
   */
  async function loadClaims(machineId: string): Promise<AdapterSessionClaimRecord[]> {
    const { claims } = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId });
    return claims;
  }

  /**
   * Read a session's agent rows.
   * @param sessionId - Session to read.
   * @returns The stored agent rows, in storage order.
   */
  async function loadAgents(sessionId: string): Promise<readonly MakaioSessionAgent[]> {
    const { agents } = await bus.request(AgentStorageSubjects.listBySession, { sessionId });
    return agents;
  }

  /**
   * Run one fresh lead start against whatever this host composed.
   * @param sessionId - Session to start the lead into.
   * @param machineId - Machine to target; an empty value probes the runtime boundary.
   * @returns Whatever the start decided.
   */
  function startLead(sessionId: string, machineId = MACHINE_ID): ReturnType<typeof startLeadAgent> {
    return startLeadAgent(bus, {
      sessionId,
      instance: {
        adapterId: ADAPTER_ID,
        machineId,
        ownerInstanceId: service?.requireOwnershipInstanceId() ?? 'hard-dependency-owner',
      },
      adapterName: ADAPTER_NAME,
      leadTransition: { kind: 'fresh' },
      expectedLeadAgentId: null,
      startRequest: { adapterId: ADAPTER_ID, sessionId, role: 'lead' },
    });
  }

  it('fails a fresh lead start loudly when no authority is composed, leaving nothing behind (case 84)', async () => {
    const sessionId = 'no-authority-fresh-start';
    await seedSession(sessionId);

    await expect(startLead(sessionId)).rejects.toThrow(RESERVE_START_SUBJECT);

    // Wave 2 §7.4's throwing-reservation rollback: the pre-dispatch row is the
    // only thing the attempt took, and it is taken back before the error
    // propagates. Nothing was dispatched, so nothing reached a provider.
    expect(dispatchedStarts).toEqual([]);
    expect(await loadAgents(sessionId)).toEqual([]);
    expect(await loadClaims(MACHINE_ID)).toEqual([]);
    expect(await loadClaims(KEYLESS_DESIGNATION_KEY.machineId)).toEqual([]);
    const { session } = await bus.request(SessionStorageSubjects.get, { sessionId });
    expect(session?.leadAgentId).toBeUndefined();
  });

  it('reports a restart failed when no authority is composed, and dispatches nothing (case 85)', async () => {
    const sessionId = 'no-authority-restart';
    await seedSession(sessionId, { adapterSessionId: 'provider-session-xyz' });
    await seedResumableAgent('restart-agent', sessionId);
    registerResumableRuntime();
    cleanups.push(registerRestartAgentsHandler(bus));

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ agentId: 'restart-agent', success: false });
    expect(result.results[0]?.success === false ? result.results[0].error : '').toContain(RESERVE_START_SUBJECT);
    // Case 107's rollback: the recovery claimed the row as `starting` before it
    // reserved, and a throwing reservation gives it back before the error
    // propagates — never leaving it `starting`, which the next send would read
    // as a phantom recovery. No generation was taken and nothing was dispatched.
    expect(dispatchedRehydrates).toEqual([]);
    expect(await loadClaims(MACHINE_ID)).toEqual([]);
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'restart-agent' });
    // Back to `idle`, which is where the claim found it. This agent is a *live*
    // one being restarted — the restart handler claims those by design — and
    // nothing here reached the provider, so its connector is exactly as it was.
    // Writing `dead` would advertise a running agent as recoverable, and the
    // per-turn activity stamp could never lift it back out. Case 107's own
    // fixture recovers a `dead` agent, where this same rule writes `dead`.
    expect(agent?.status).toBe('idle');
    expect(agent?.adapterId).toBe(ADAPTER_ID);
  });

  it('uses the selected machine as the runtime owner when the authority designates under its sentinel (case 86, Path A)', async () => {
    const sessionId = 'no-machine-identity-fresh-start';
    const authority = await composeAuthority();
    // An idle start, so the case is about the reservation and nothing else: a
    // start that *does* report a provider session goes on to settle currency,
    // and a settlement is keyed and therefore genuinely needs an identity.
    startedProviderSessionId = null;
    await bus.request(SessionSubjects.create, { sessionId });

    const result = await startLead(sessionId);

    // Path A's reservation is keyless, so it never reads the machine-scoped key
    // triple and cannot answer `machine-identity-unavailable`. It designates and
    // starts, and it takes no claim row on any machine — including the sentinel
    // the designation writes through.
    expect(result.outcome).toBe('started');
    expect(dispatchedStarts).toHaveLength(1);
    const { session } = await bus.request(SessionSubjects.get, { sessionId });
    expect(session?.leadAgentId).toBe(dispatchedStarts[0]);
    expect(await loadClaims(KEYLESS_DESIGNATION_KEY.machineId)).toEqual([]);
    const agents = await loadAgents(sessionId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe('idle');
    expect(agents[0]?.runtimeOwner).toEqual({
      machineId: MACHINE_ID,
      instanceId: authority.requireOwnershipInstanceId(),
    });
  });

  it('refuses an unscoped fresh lead start before it reserves, persists, or dispatches', async () => {
    const sessionId = 'no-machine-identity-keyed-settlement';
    await composeAuthority();
    await bus.request(SessionSubjects.create, { sessionId });

    await expect(startLead(sessionId, '')).rejects.toMatchObject({ code: 'start-failed' });

    expect(dispatchedStarts).toEqual([]);
    expect(await loadClaims(KEYLESS_DESIGNATION_KEY.machineId)).toEqual([]);
    const agents = await loadAgents(sessionId);
    expect(agents).toEqual([]);
  });

  it('reserves and dispatches a restart normally once the authority is composed (case 85, control)', async () => {
    const sessionId = 'authority-restart';
    await composeAuthority(MACHINE_ID);
    await bus.request(SessionSubjects.create, { sessionId, machineId: MACHINE_ID });
    const { session } = await bus.request(SessionSubjects.get, { sessionId });
    if (!session) throw new Error('Session not found after create');
    await bus.request(SessionStorageSubjects.set, {
      sessionId,
      session: { ...session, adapterSessionId: 'provider-session-xyz' },
    });
    await seedResumableAgent('restart-agent', sessionId);
    registerResumableRuntime();

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId });

    // The control for the case above: the same fixture with the authority
    // composed reserves, dispatches and settles. Without it, "reports failed"
    // would pass for any reason at all — a plan that never reached a
    // reservation included.
    expect(result.results).toEqual([{ agentId: 'restart-agent', adapterId: ADAPTER_ID, success: true }]);
    expect(dispatchedRehydrates).toEqual(['restart-agent']);
    expect(await loadClaims(MACHINE_ID)).toHaveLength(1);
  });
});
