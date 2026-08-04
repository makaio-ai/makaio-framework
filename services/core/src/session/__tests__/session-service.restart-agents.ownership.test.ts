import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { MakaioSessionService } from '../session-service.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { runExclusiveStart } from '../ownership/in-flight-starts.js';
import { createTestAgent, registerMemorySessionBackends, settleEventLoop } from './shared.js';

/** A gate the test opens by hand, so the join window is deterministic. */
interface Deferred {
  /** Resolves when {@link Deferred.resolve} is called. */
  promise: Promise<void>;
  /** Open the gate. */
  resolve: () => void;
}

/**
 * Create a gate the test opens by hand.
 * @returns The gate.
 */
function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Path B — the reserved rehydrate (§7.2).
 *
 * Real memory backends behind the real bus throughout: the reservation, the
 * settlement and the claim rows they produce are the thing under test, so a
 * mocked ownership seam would assert only that the handler called it.
 */

/** Machine the authority is composed with, and therefore claims under. */
const MACHINE_ID = 'restart-ownership-machine';
/** The instance `adapterRuntime.resolveId` answers with — never the stored one. */
const LIVE_ADAPTER_ID = 'live-test-adapter';
/** The instance persisted on the agent rows, stale by construction. */
const STALE_ADAPTER_ID = 'stale-test-adapter';

describe('MakaioSessionService - restartAgents ownership', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let storageCleanups: Array<() => void> = [];
  /** Every adapter-instance resolution the handler issued, in order. */
  let resolveIdRequests: Array<{ adapterName: string; machineId?: string }> = [];

  beforeEach(async () => {
    resolveIdRequests = [];
    bus = createBusInstance();
    storageCleanups = [
      ...registerMemorySessionBackends(bus),
      bus.on(AdapterRuntimeSubjects.getMachineId, (ctx) => {
        ctx.setResult({ machineId: MACHINE_ID });
      }),
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        resolveIdRequests.push({ adapterName: ctx.payload.adapterName, machineId: ctx.payload.machineId });
        ctx.setResult({ adapterId: LIVE_ADAPTER_ID });
      }),
      bus.on(AdapterSubjects.getCapabilities, (ctx) => {
        ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
      }),
    ];
    service = new MakaioSessionService(bus, { machineId: MACHINE_ID });
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    for (let index = storageCleanups.length - 1; index >= 0; index -= 1) storageCleanups[index]?.();
    storageCleanups = [];
  });

  /**
   * Create a session whose locality resolves as native, plus one agent on it.
   * @param sessionId - Session to create
   * @param agentId - Agent to persist into it
   * @param overrides - Agent field overrides
   * @param machineId - Machine the session row records as its own
   * @returns The provider session the agent's plan will resume
   */
  async function seedResumableAgent(
    sessionId: string,
    agentId: string,
    overrides?: Partial<MakaioSessionAgent>,
    machineId: string = MACHINE_ID,
  ): Promise<string> {
    await bus.request(SessionSubjects.create, { sessionId, machineId });
    const adapterSessionId = `provider-${agentId}`;
    await bus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        adapterId: STALE_ADAPTER_ID,
        adapterName: 'test-adapter',
        adapterSessionId,
        ...overrides,
      }),
    });
    return adapterSessionId;
  }

  /**
   * Record every rehydrate dispatch, answering as the adapter does.
   * @param onDispatch - Optional side effect run before the response
   * @returns The captured dispatches, in order
   */
  function captureRehydrates(onDispatch?: (agentId: string) => Promise<void> | void): Array<Record<string, unknown>> {
    const dispatched: Array<Record<string, unknown>> = [];
    storageCleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
        dispatched.push(ctx.payload);
        await onDispatch?.(ctx.payload.agentId);
        ctx.setResult({});
      }),
    );
    return dispatched;
  }

  /**
   * List every claim the authority's machine holds.
   * @returns The claim rows.
   */
  async function listClaims() {
    const { claims } = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
    return claims;
  }

  it('degrades to fresh-with-history when another generation owns the provider session', async () => {
    // Case 39. The key is taken by a live incumbent, so the restart may not
    // dispatch a second connector at it — and a degrade is not a failure: the
    // send path recovers the agent with injected history.
    const adapterSessionId = await seedResumableAgent('session-occupied', 'agent-occupied');
    await bus.request(SessionSubjects.create, { sessionId: 'session-incumbent', machineId: MACHINE_ID });
    await bus.request(AgentStorageSubjects.set, {
      agentId: 'agent-incumbent',
      agent: createTestAgent('agent-incumbent', { sessionId: 'session-incumbent', adapterId: LIVE_ADAPTER_ID }),
    });
    const held = await bus.request(SessionOwnershipStorageSubjects.claim, {
      machineId: MACHINE_ID,
      adapterId: LIVE_ADAPTER_ID,
      adapterName: 'test-adapter',
      providerSessionId: adapterSessionId,
      sessionId: 'session-incumbent',
      agentId: 'agent-incumbent',
      claimToken: crypto.randomUUID(),
    });
    expect(held.outcome).toBe('claimed');

    const dispatched = captureRehydrates();
    const result = await bus.request(SessionSubjects.restartAgents, { sessionId: 'session-occupied' });

    expect(result.results).toEqual([
      // The stale adapter ID is reported precisely because nothing was
      // dispatched: no binding to the live instance exists to advertise.
      { agentId: 'agent-occupied', adapterId: STALE_ADAPTER_ID, success: true },
    ]);
    expect(dispatched).toHaveLength(0);
    const claims = await listClaims();
    expect(claims.map((claim) => claim.agentId)).toEqual(['agent-incumbent']);
  });

  it('reserves, dispatches, settles and persists against the freshly resolved adapter instance', async () => {
    // Case 40. A persisted adapter ID goes stale across a restart. Reserving
    // against it would take the key in a namespace the dispatch never uses, so
    // every step has to name one instance — the live one.
    const adapterSessionId = await seedResumableAgent('session-stale-id', 'agent-stale-id');
    const dispatched = captureRehydrates();

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId: 'session-stale-id' });

    expect(result.results).toEqual([{ agentId: 'agent-stale-id', adapterId: LIVE_ADAPTER_ID, success: true }]);
    expect(dispatched).toEqual([
      expect.objectContaining({
        adapterId: LIVE_ADAPTER_ID,
        agentId: 'agent-stale-id',
        resumeAdapterSessionId: adapterSessionId,
      }),
    ]);

    const claims = await listClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toEqual(
      expect.objectContaining({
        agentId: 'agent-stale-id',
        adapterId: LIVE_ADAPTER_ID,
        providerSessionId: adapterSessionId,
        status: 'held',
      }),
    );

    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-stale-id' });
    expect(agent?.adapterId).toBe(LIVE_ADAPTER_ID);
  });

  it('settles the resumed provider session onto the agent row', async () => {
    // Case 43. The rehydrate re-attaches the connector to a conversation this
    // runtime just reserved, so the currency has to name it — and the adapter's
    // own unconditional `idle` write is unordered with respect to the
    // settlement, which is harmless because status is neither liveness nor
    // ownership evidence.
    const adapterSessionId = await seedResumableAgent('session-settled', 'agent-settled');
    captureRehydrates(async (agentId) => {
      // Exactly what `ai-adapter-rehydration` does, and deliberately *before*
      // the service settles.
      await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
    });

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId: 'session-settled' });
    expect(result.results).toEqual([{ agentId: 'agent-settled', adapterId: LIVE_ADAPTER_ID, success: true }]);

    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, { agentId: 'agent-settled' });
    expect(ownership?.currency).toEqual(
      expect.objectContaining({ currentAdapterSessionId: adapterSessionId, currentAdapterSessionIdState: 'confirmed' }),
    );
    expect(ownership?.currencyFence).toBeGreaterThan(0);

    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-settled' });
    expect(agent?.status).toBe('idle');
  });

  it('skips a disposed agent before reserving anything', async () => {
    // Case 41. Rehydrating a removed agent throws and every ownership operation
    // refuses it by predicate, so the round-trip would only turn a known answer
    // into a slower one.
    await seedResumableAgent('session-disposed', 'agent-disposed', { status: 'disposed' });
    const dispatched = captureRehydrates();

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId: 'session-disposed' });

    expect(result.results).toEqual([
      {
        agentId: 'agent-disposed',
        adapterId: STALE_ADAPTER_ID,
        success: false,
        error: expect.stringContaining('disposed'),
      },
    ]);
    expect(dispatched).toHaveLength(0);
    expect(await listClaims()).toEqual([]);
  });

  it('abandons the reserved claim and writes no status when the rehydrate throws', async () => {
    // Case 42. `rehydrateAgent` has no failure response, so every failure is a
    // throw and therefore of unknown extent: the provider may still hold a live
    // session, which is why the claim is retired as `abandoned` rather than
    // released. The row's status belongs to the adapter on this path and the
    // service must not touch it.
    await seedResumableAgent('session-throwing', 'agent-throwing');
    storageCleanups.push(
      bus.on(AdapterSubjects.rehydrateAgent, () => {
        throw new Error('connector refused to come back');
      }),
    );

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId: 'session-throwing' });

    expect(result.results).toEqual([
      {
        agentId: 'agent-throwing',
        adapterId: STALE_ADAPTER_ID,
        success: false,
        error: expect.stringContaining('connector refused'),
      },
    ]);
    const claims = await listClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).toBe('abandoned');

    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-throwing' });
    // Untouched: `createTestAgent` persists `idle`, and no service write moved it.
    expect(agent?.status).toBe('idle');
  });

  it('refuses the settlement and releases cleanly when a removal lands mid-rehydrate', async () => {
    // Case 45 — the ownership half of I12. `disposed` is absorbing for
    // ownership, enforced by storage predicates rather than by a service-side
    // status check, so a removal that lands while the connector is coming back
    // is honoured by the settlement that follows it. A removal is a deliberate
    // stop, so the key is given back cleanly and the connector is torn down.
    //
    // The removal survives the adapter's unconditional post-rehydrate `idle`
    // write, because `disposed` is terminal at the storage layer: neither the
    // status seam nor a whole-record `set` can hand a removed agent a
    // live-looking status for a later predicate to read.
    const adapterSessionId = await seedResumableAgent('session-i12', 'agent-i12');
    captureRehydrates(async (agentId) => {
      await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });
      // What `ai-adapter-rehydration` does on the way out, and what the
      // start handler's whole-record persistence would do — both refused.
      await bus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
      const { agent } = await bus.request(AgentStorageSubjects.get, { agentId });
      if (agent) await bus.request(AgentStorageSubjects.set, { agentId, agent: { ...agent, status: 'idle' } });
    });
    const stopped: string[] = [];
    storageCleanups.push(
      bus.on(AdapterSubjects.stopAgent, (ctx) => {
        stopped.push(ctx.payload.agentId);
        ctx.setResult({ success: true });
      }),
    );

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId: 'session-i12' });

    expect(result.results).toEqual([
      {
        agentId: 'agent-i12',
        // The live instance: the rehydrate *did* happen and bound the agent to
        // it. Only the ownership of what that connector talks to was refused.
        adapterId: LIVE_ADAPTER_ID,
        success: false,
        error: expect.stringContaining('agent-disposed'),
      },
    ]);
    expect(stopped).toEqual(['agent-i12']);
    // A clean release is the one disposition that frees the key, so the row is
    // gone rather than marked — nothing blocks the next legitimate owner.
    expect(await listClaims()).toEqual([]);

    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, { agentId: 'agent-i12' });
    expect(ownership?.currency.currentAdapterSessionId).toBeNull();
    expect(ownership?.currencyFence).toBe(0);

    // The two revival attempts above wrote nothing: the row still names the
    // removal, which is what every ownership predicate reads.
    const { agent: revived } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-i12' });
    expect(revived?.status).toBe('disposed');

    // And a reservation issued afterwards is refused by the same predicate,
    // having written nothing.
    const reserved = await bus.request(SessionSubjects.ownership.reserveStart, {
      sessionId: 'session-i12',
      agentId: 'agent-i12',
      adapterId: LIVE_ADAPTER_ID,
      adapterName: 'test-adapter',
      role: 'member',
      resumeProviderSessionId: adapterSessionId,
    });
    expect(reserved.outcome).toBe('agent-disposed');
  });

  it('reports the reservation outcome when the agent row is gone', async () => {
    // The refusal branch of §7.2 step 4: neither a degrade nor a throw, but an
    // outcome the caller has to see named. Deleting the agent row between the
    // listing and the reservation is the reachable shape — a removal landing
    // mid-restart.
    await seedResumableAgent('session-vanishing', 'agent-vanishing');
    storageCleanups.push(
      bus.on(
        AdapterSubjects.getCapabilities,
        async (ctx) => {
          await bus.request(AgentStorageSubjects.delete, { agentId: 'agent-vanishing' });
          ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
        },
        { priority: 100 },
      ),
    );
    const dispatched = captureRehydrates();

    const result = await bus.request(SessionSubjects.restartAgents, { sessionId: 'session-vanishing' });

    expect(result.results).toEqual([
      {
        agentId: 'agent-vanishing',
        adapterId: STALE_ADAPTER_ID,
        success: false,
        error: expect.stringContaining('not-found'),
      },
    ]);
    expect(dispatched).toHaveLength(0);
  });
  it('joins an in-flight start instead of reserving, persisting and settling beside it', async () => {
    // The seam is keyed by agent identity, so a restart that finds an attempt
    // already running for its agent ran none of that attempt's steps. It must
    // therefore write none of them either: its own adapter instance and its own
    // planned provider session describe a dispatch that never happened, and
    // persisting them would overwrite the identity the running attempt is
    // establishing.
    const adapterSessionId = await seedResumableAgent('session-joined', 'agent-joined');
    const dispatched = captureRehydrates();

    // The attempt in flight: another instance of this runtime's start path,
    // which will bind the agent to its own adapter instance.
    const attempt = createDeferred();
    const inFlight = runExclusiveStart('agent-joined', async () => {
      await attempt.promise;
      await bus.request(AgentStorageSubjects.updateRuntime, {
        agentId: 'agent-joined',
        adapterId: 'other-live-adapter',
      });
    });

    const restart = bus.request(SessionSubjects.restartAgents, { sessionId: 'session-joined' });
    await settleEventLoop();
    // Nothing yet: the restart is waiting on the attempt it joined.
    expect(dispatched).toHaveLength(0);
    expect(await listClaims()).toEqual([]);

    attempt.resolve();
    await inFlight.settled;
    const result = await restart;

    expect(result.results).toEqual([
      // The instance the joined attempt bound the agent to, read back from the
      // row — never the one this call resolved for a dispatch it never made.
      { agentId: 'agent-joined', adapterId: 'other-live-adapter', success: true },
    ]);
    expect(dispatched).toHaveLength(0);
    // No claim was taken and no currency was settled: the provider session this
    // restart planned to resume is not one it can say the agent is on.
    expect(await listClaims()).toEqual([]);
    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, { agentId: 'agent-joined' });
    expect(ownership?.currency.currentAdapterSessionId).toBeNull();
    expect(adapterSessionId).toBe('provider-agent-joined');
  });
  it('reports failure when the start it joined rejected, rather than reading the untouched row', async () => {
    // The wave's rule is that the row an attempt leaves behind is the verdict —
    // and it holds only because a failing attempt writes that row. A fresh start
    // does: it deletes the row before dispatch and compare-and-swaps it to
    // `dead` after one, so a Path-A joiner reads the failure off the row. A
    // rehydrate writes no status at all — the adapter owns that column here — so
    // a failed Path-B attempt leaves the row exactly as it found it, which for a
    // restart is a pre-existing `idle`. Classifying *that* would report the
    // row's pre-attempt state as the attempt's result.
    await seedResumableAgent('session-joined-failure', 'agent-joined-failure');
    const dispatched = captureRehydrates();

    const attempt = createDeferred();
    const inFlight = runExclusiveStart('agent-joined-failure', async () => {
      await attempt.promise;
      throw new Error('connector refused to come back');
    });

    const restart = bus.request(SessionSubjects.restartAgents, { sessionId: 'session-joined-failure' });
    await settleEventLoop();
    attempt.resolve();
    await inFlight.settled.catch(() => undefined);
    const result = await restart;

    expect(result.results).toEqual([
      {
        agentId: 'agent-joined-failure',
        adapterId: STALE_ADAPTER_ID,
        success: false,
        error: expect.stringContaining('connector refused'),
      },
    ]);
    expect(dispatched).toHaveLength(0);
    // The row is untouched, which is exactly why it may not be classified: it
    // still says `idle` from before the attempt ever ran.
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: 'agent-joined-failure' });
    expect(agent?.status).toBe('idle');
    expect(agent?.adapterId).toBe(STALE_ADAPTER_ID);
    expect(await listClaims()).toEqual([]);
  });
  it('reserves and settles under the machine identity the caller named', async () => {
    // The payload override is the documented test/ops escape hatch, and the
    // restart already plans locality against it. The reservation has to name the
    // same machine: the ownership key starts with it, so reserving under the
    // composed identity while reasoning about another would take the key in a
    // namespace the plan is not about — and on a host with no identity of its
    // own the reservation would refuse outright, defeating the override.
    const namedMachine = 'operator-named-machine';
    // The session belongs to the named machine, which is what makes its provider
    // session natively resumable *for that machine* — the case an operator names
    // it for.
    const adapterSessionId = await seedResumableAgent(
      'session-named-machine',
      'agent-named-machine',
      undefined,
      namedMachine,
    );
    const dispatched = captureRehydrates();

    const result = await bus.request(SessionSubjects.restartAgents, {
      sessionId: 'session-named-machine',
      machineId: namedMachine,
    });

    expect(result.results).toEqual([{ agentId: 'agent-named-machine', adapterId: LIVE_ADAPTER_ID, success: true }]);
    expect(dispatched).toHaveLength(1);

    // The adapter instance was derived for the named machine too. An instance ID
    // is a function of (machineId, adapterName), so resolving it for the runtime
    // while reserving for the caller's machine would build a key no other actor
    // computes — one that collides with nothing and therefore protects nothing.
    expect(resolveIdRequests).toEqual([{ adapterName: 'test-adapter', machineId: namedMachine }]);

    // The claim lives in the named machine's namespace, and in no other.
    const named = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: namedMachine });
    expect(named.claims).toEqual([
      expect.objectContaining({
        agentId: 'agent-named-machine',
        providerSessionId: adapterSessionId,
        status: 'held',
      }),
    ]);
    expect(await listClaims()).toEqual([]);

    // And the settlement went through that same generation rather than being
    // refused as somebody else's.
    const { ownership } = await bus.request(SessionOwnershipStorageSubjects.read, { agentId: 'agent-named-machine' });
    expect(ownership?.currency.currentAdapterSessionId).toBe(adapterSessionId);
    expect(ownership?.currencyFence).toBeGreaterThan(0);
  });
});
