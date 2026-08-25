import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { buildDeterministicAdapterId, registerAdapterRuntimeIdentityHandlers } from '../../adapter-runtime/identity.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { callerOwnedSuccessFields, registerCallerSettlementAckHandler } from '../testing/caller-owned-adapter-stub.js';
import { registerMockProviderHandlers, registerMockStorageHandlers } from '../testing/index.js';
import {
  registerSendMessageHandler,
  registerStartAgentHandler,
  resetBusHandlers,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';
import { createTestAgent, registerMemorySessionBackends } from './shared.js';

export const DEFERRAL_MACHINE_ID = 'deferral-machine';
export const DEFERRAL_LIVE_ADAPTER_ID = buildDeterministicAdapterId(DEFERRAL_MACHINE_ID, 'test-adapter');
const STALE_ADAPTER_ID = 'stale-adapter';

/** A live harness for send deferral policy cases. */
export class SendDeferralPolicyHarness {
  public readonly routed: string[] = [];
  public readonly routedContexts = new Map<string, unknown>();
  public readonly dispatched: Array<Record<string, unknown>> = [];
  public readonly liveAgentIds = new Set<string>();
  public readonly probedAgentIds: string[] = [];
  public readonly occupiedAgentIds = new Set<string>();
  public readonly service = new MakaioSessionService(MakaioBus, { machineId: DEFERRAL_MACHINE_ID });
  public readonly orchestrator: SessionOrchestrator;
  private cleanups: UnsubscribeFunction[] = [];

  private constructor() {
    this.orchestrator = new SessionOrchestrator(MakaioBus, DEFERRAL_MACHINE_ID);
  }

  /** Create and initialize a fully composed deferral-policy harness. */
  public static async create(): Promise<SendDeferralPolicyHarness> {
    resetBusHandlers();
    const harness = new SendDeferralPolicyHarness();
    harness.cleanups.push(...registerMemorySessionBackends(MakaioBus));
    harness.cleanups.push(registerMemorySessionEventStorage(MakaioBus));
    harness.cleanups.push(registerMockStorageHandlers({ omit: ['adapter', 'agent', 'session'] }));
    harness.cleanups.push(registerCallerSettlementAckHandler(MakaioBus));
    harness.cleanups.push(registerMockProviderHandlers());
    harness.cleanups.push(
      MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
        harness.probedAgentIds.push(ctx.payload.agentId);
        ctx.setResult(
          harness.liveAgentIds.has(ctx.payload.agentId)
            ? { agent: { agentId: ctx.payload.agentId, sessionId: 'unused', adapterSessionId: 'adapter-session' } }
            : { agent: null },
        );
      }),
      MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        harness.dispatched.push(ctx.payload);
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
      }),
      registerStartAgentHandler(),
      registerSendMessageHandler((payload) => {
        harness.routed.push(payload.agentId);
        harness.routedContexts.set(payload.agentId, payload.sessionContext);
      }),
    );
    await harness.service.init();
    const { registry, cleanup } = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
      currentMachineId: DEFERRAL_MACHINE_ID,
      knownAdapterNames: ['test-adapter'],
    });
    registry.rememberLiveIdentity({
      adapterId: DEFERRAL_LIVE_ADAPTER_ID,
      adapterName: 'test-adapter',
      machineId: DEFERRAL_MACHINE_ID,
      ownerInstanceId: harness.service.requireOwnershipInstanceId(),
    });
    harness.cleanups.push(cleanup);
    harness.cleanups.push(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        (ctx) => {
          // eslint-disable-next-line custom/prefer-bus-filter -- the injector must see every reservation so it can pass the rest through
          if (!harness.occupiedAgentIds.has(ctx.payload.agentId)) return ctx.next();
          ctx.setResult({ outcome: 'occupied', holder: foreignHolder(ctx.payload.agentId) });
        },
        { priority: 100 },
      ),
    );
    return harness;
  }

  /** Dispose the composed service, orchestrator and registered handlers. */
  public destroy(): void {
    this.orchestrator.destroy();
    this.service.destroy();
    for (let index = this.cleanups.length - 1; index >= 0; index -= 1) this.cleanups[index]?.();
    this.cleanups = [];
  }

  /**
   * Register a test-specific handler to dispose with the harness.
   * @param cleanup - Handler cleanup to run during teardown.
   */
  public addCleanup(cleanup: UnsubscribeFunction): void {
    this.cleanups.push(cleanup);
  }

  /**
   * Create a stale-bound session that the liveness/recovery path can exercise.
   * @param sessionId - Session to create.
   * @param agentIds - Agents to persist; the first one leads.
   * @param options - Whether to omit runtime ownership or override individual rows.
   * @returns The stored agent rows.
   */
  public async seedSession(
    sessionId: string,
    agentIds: readonly string[],
    options: { legacy?: boolean; agentOverrides?: Readonly<Record<string, Partial<MakaioSessionAgent>>> } = {},
  ): Promise<MakaioSessionAgent[]> {
    await MakaioBus.request(SessionSubjects.create, { sessionId, machineId: DEFERRAL_MACHINE_ID });
    const agents: MakaioSessionAgent[] = [];
    for (const agentId of agentIds) {
      const agent = createTestAgent(agentId, {
        sessionId,
        adapterId: STALE_ADAPTER_ID,
        adapterSessionId: `provider-${agentId}`,
        role: agentId === agentIds[0] ? 'lead' : 'member',
        ...(!options.legacy && {
          runtimeOwner: { machineId: DEFERRAL_MACHINE_ID, instanceId: this.service.requireOwnershipInstanceId() },
        }),
        cwd: '/work/repo',
        allowedDirectories: ['/work/repo'],
        providerConfigId: 'provider-config-abc',
        ...options.agentOverrides?.[agentId],
      });
      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent });
      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId,
        adapterId: STALE_ADAPTER_ID,
        adapterName: agent.adapterName,
        adapterSessionId: agent.adapterSessionId as string,
        role: agent.role,
      });
      agents.push(agent);
    }
    return agents;
  }

  /**
   * State that one agent's provider session belongs to a foreign generation.
   * @param agent - Agent this runtime may not drive.
   */
  public occupyAgentKey(agent: MakaioSessionAgent): void {
    this.occupiedAgentIds.add(agent.agentId);
  }
}

/**
 * The generation a refused reservation reports as the holder.
 * @param agentId - Agent whose key is held elsewhere.
 * @returns A claim record naming a foreign owner.
 */
function foreignHolder(agentId: string) {
  const now = Date.now();
  return {
    claimId: `claim-${agentId}`,
    machineId: DEFERRAL_MACHINE_ID,
    adapterId: DEFERRAL_LIVE_ADAPTER_ID,
    adapterName: 'test-adapter',
    providerSessionId: `provider-${agentId}`,
    sessionId: 'session-foreign',
    agentId: `foreign-${agentId}`,
    claimToken: `token-${agentId}`,
    fence: 1,
    ownerInstanceId: `foreign-owner-${agentId}`,
    status: 'held' as const,
    claimedAt: now,
    updatedAt: now,
  };
}
