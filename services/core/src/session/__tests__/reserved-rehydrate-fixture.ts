/**
 * The composition Path B's cases run against.
 *
 * Real memory session, agent and ownership backends over one state, the real
 * authority, and a real consumer as the caller: the claim rows, the currency and
 * the agent rows the cases assert are the durable effects of the seam under
 * test, so nothing about it is stubbed. The only stand-ins are the adapter —
 * which is a different process's concern — and the fault injectors a case
 * registers itself, always **before** the backend they shadow, because the first
 * registered request handler wins.
 *
 * Extracted so the cases read as cases. It is a fixture, not a helper library:
 * everything here is composition and seeding, and no assertion lives in it.
 */
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type AdapterSessionClaimRecord,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import type { ExtractSubjectResponse } from '@makaio/core';
import { MakaioSessionService } from '../session-service.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { recoverAgent } from '../utils/agent-recovery.js';
import type { RecoveryPlan } from '../recovery-plan.js';
import { createTestAgent, registerMemorySessionBackends } from './shared.js';

/** What the adapter stand-in answers a rehydrate with. */
export type RehydrateAnswer = ExtractSubjectResponse<typeof AdapterSubjects.rehydrateAgent>;

/** Machine the authority is composed with, and therefore claims under. */
export const MACHINE_ID = 'reserved-rehydrate-machine';
/** Adapter instance every recovery in this suite is addressed to. */
export const ADAPTER_ID = 'live-adapter';
/** A foreign agent that holds a key on the *same* adapter instance. */
export const FOREIGN_AGENT_ID = 'agent-foreign';
/** Key a connector landed on that its reservation never named. */
export const MOVED_KEY = 'provider-moved-to';
/**
 * Run a fault ahead of the backend it shadows.
 *
 * The memory backends are registered before any case runs and the first
 * matching request handler answers, so an injector has to say so explicitly.
 */
export const FIRST = { priority: 100 } as const;

/** Everything a Path-B case drives and observes. */
export interface ReservedRehydrateContext {
  /** Bus the whole composition lives on. */
  readonly bus: IMakaioBus;
  /** Every agent `adapter.stopAgent` was asked to stop, in order. */
  readonly stopped: string[];
  /** Every rehydrate the adapter stand-in observed, in order. */
  readonly dispatched: Array<Record<string, unknown>>;
  /**
   * Register a teardown to run before the composition is destroyed.
   * @param cleanup - The unsubscribe to run.
   */
  track: (cleanup: () => void) => void;
  /**
   * Answer rehydrates as the adapter does, recording every payload.
   * @param respond - What the adapter answers, and any side effect it performs first.
   */
  registerAdapter: (
    respond?: (agentId: string) => Promise<RehydrateAnswer | undefined> | RehydrateAnswer | undefined,
  ) => void;
  /**
   * Seed a session and one agent row with a provider session of its own.
   * @param sessionId - Session to create.
   * @param agentId - Agent to persist into it.
   * @param overrides - Agent field overrides.
   */
  seedAgent: (
    sessionId: string,
    agentId: string,
    overrides?: Partial<MakaioSessionAgent>,
  ) => Promise<MakaioSessionAgent>;
  /**
   * Take a generation for a *different* agent on the same adapter instance.
   * @param providerSessionId - Key to occupy.
   */
  occupyKey: (providerSessionId: string) => Promise<AdapterSessionClaimRecord>;
  /** @returns The claims this machine holds, in storage order. */
  listClaims: () => Promise<readonly AdapterSessionClaimRecord[]>;
  /**
   * Read one agent's stored status.
   * @param agentId - Agent to read.
   */
  readStatus: (agentId: string) => Promise<string | undefined>;
  /**
   * Recover one agent under a plan.
   * @param agent - Agent to recover.
   * @param plan - Recovery plan the consumer runs under.
   */
  recover: (agent: MakaioSessionAgent, plan: RecoveryPlan) => ReturnType<typeof recoverAgent>;
  /** Tear the composition down, in reverse registration order. */
  destroy: () => void;
}

/**
 * Compose the backends, the authority and the adapter stand-in for one case.
 * @returns The context the case drives and observes.
 */
export async function createReservedRehydrateContext(): Promise<ReservedRehydrateContext> {
  const bus = createBusInstance();
  const stopped: string[] = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const cleanups: Array<() => void> = [...registerMemorySessionBackends(bus)];
  const service = new MakaioSessionService(bus, { machineId: MACHINE_ID });
  await service.init();
  cleanups.push(
    bus.on(AdapterSubjects.stopAgent, (ctx) => {
      stopped.push(ctx.payload.agentId);
      ctx.setResult({ success: true, evidence: 'released' });
    }),
  );

  return {
    bus,
    stopped,
    dispatched,
    track: (cleanup) => cleanups.push(cleanup),
    registerAdapter: (respond) => {
      cleanups.push(
        bus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
          dispatched.push(ctx.payload);
          const answer = await respond?.(ctx.payload.agentId);
          ctx.setResult(answer ?? { success: true });
        }),
      );
    },
    seedAgent: async (sessionId, agentId, overrides) => {
      await bus.request(SessionSubjects.create, { sessionId, machineId: MACHINE_ID });
      const agent = createTestAgent(agentId, {
        sessionId,
        adapterId: ADAPTER_ID,
        adapterSessionId: `provider-${agentId}`,
        status: 'dead',
        ...overrides,
      });
      await bus.request(AgentStorageSubjects.set, { agentId, agent });
      return agent;
    },
    occupyKey: async (providerSessionId) => {
      // The ownership key is `(machine, adapter instance, provider session)`, so
      // an occupancy naming another instance would be a different key and would
      // not conflict at all.
      await bus.request(SessionSubjects.create, { sessionId: 'session-foreign', machineId: MACHINE_ID });
      await bus.request(AgentStorageSubjects.set, {
        agentId: FOREIGN_AGENT_ID,
        agent: createTestAgent(FOREIGN_AGENT_ID, { sessionId: 'session-foreign', adapterId: ADAPTER_ID }),
      });
      const held = await bus.request(SessionOwnershipStorageSubjects.claim, {
        machineId: MACHINE_ID,
        adapterId: ADAPTER_ID,
        adapterName: 'test-adapter',
        providerSessionId,
        sessionId: 'session-foreign',
        agentId: FOREIGN_AGENT_ID,
        claimToken: crypto.randomUUID(),
      });
      if (held.outcome !== 'claimed' || held.claim === null) {
        throw new Error(`expected the foreign claim to land: ${held.outcome}`);
      }
      return held.claim;
    },
    listClaims: async () => {
      const { claims } = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
      return claims;
    },
    readStatus: async (agentId) => {
      const { agent } = await bus.request(AgentStorageSubjects.get, { agentId });
      return agent?.status;
    },
    recover: (agent, plan) => recoverAgent(bus, agent, { plan }, { adapterId: ADAPTER_ID }),
    destroy: () => {
      service.destroy();
      for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
      cleanups.length = 0;
    },
  };
}
