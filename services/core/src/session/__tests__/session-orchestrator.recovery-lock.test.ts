import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionOwnershipStorageSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession, MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { MakaioSessionService } from '../session-service.js';
import { runExclusiveStart } from '../ownership/in-flight-starts.js';
import { resolveInFlightStarts } from '../handlers/in-flight-start-join.js';
import { runReservedRehydrate, type ReservedRehydrateOutcome } from '../handlers/reserved-rehydrate.js';
import { buildRecoveryReservationGuard, readRecoveryPlanningSnapshot } from '../handlers/recovery-reservation.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import { callerOwnedSuccessFields } from '../testing/caller-owned-adapter-stub.js';
import { createTestAgent, registerMemorySessionBackends, settleEventLoop } from './shared.js';
import { createMockSession } from '../testing/orchestrator-shared.js';
import {
  registerRehydrateAgentHandler,
  registerCwdChangeHandler,
  resetBusHandlers,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** Create a deterministic test gate. */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

/** Machine identity the orchestrator and the authority share. */
const MACHINE_ID = 'test-machine';

describe('SessionOrchestrator - Recovery Overlap', () => {
  let orchestrator: SessionOrchestrator;
  let service: MakaioSessionService;
  let unsubscribers: UnsubscribeFunction[];
  /** The dead-agent probe, replaced per test. */
  let probeUnsub: UnsubscribeFunction | undefined;
  /** The rehydrate stand-in, replaced per test. */
  let rehydrateUnsub: UnsubscribeFunction | undefined;
  /**
   * Agents a rehydrate has been dispatched for.
   *
   * The probe reads it so a recovered agent stops looking dead: an adapter that
   * kept reporting `null` after rebuilding a connector would make every later
   * send recover the same agent again, which is a fixture artefact rather than
   * the behaviour under test.
   */
  let rehydratedAgentIds: Set<string>;

  beforeEach(async () => {
    resetBusHandlers();
    unsubscribers = [];
    rehydratedAgentIds = new Set<string>();
    // A lazy recovery reserves before it dispatches, so the session, agent and
    // ownership rows come from the real memory backends over one shared state
    // and the real service registers the authority they reserve from. Only the
    // turn/message/routing surface is stubbed.
    unsubscribers.push(...registerMemorySessionBackends(MakaioBus));
    unsubscribers.push(registerMemorySessionEventStorage(MakaioBus));
    unsubscribers.push(registerMockStorageHandlers({ omit: ['agent', 'session'] }));
    rehydrateUnsub = registerRehydrateAgentHandler();
    unsubscribers.push(registerCwdChangeHandler());
    service = new MakaioSessionService(MakaioBus, { machineId: MACHINE_ID });
    await service.init();
    orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
    await publishLiveTestAdapter();
    const liveAdapter = await MakaioBus.request(AdapterRuntimeSubjects.resolveId, {
      adapterName: 'test-adapter',
      machineId: MACHINE_ID,
    });
    await expect(
      MakaioBus.request(AdapterRuntimeSubjects.resolveLiveIdentity, {
        adapterId: liveAdapter.adapterId,
        adapterName: 'test-adapter',
        machineId: MACHINE_ID,
      }),
    ).resolves.toMatchObject({ ownerInstanceId: service.requireOwnershipInstanceId() });
  });

  afterEach(() => {
    orchestrator?.destroy();
    service?.destroy();
    probeUnsub?.();
    rehydrateUnsub?.();
    unsubscribers.forEach((unsub) => unsub());
  });

  /**
   * Create a session and its agent rows in the durable state the reservation
   * verifies against.
   * @param sessionId - Session to create.
   * @param agentIds - Agents to persist into it; the first one leads.
   */
  async function seedSession(sessionId: string, agentIds: readonly string[]): Promise<void> {
    await MakaioBus.request(SessionSubjects.create, { sessionId, machineId: MACHINE_ID });
    for (const agentId of agentIds) {
      const agent: MakaioSessionAgent = createTestAgent(agentId, {
        sessionId,
        role: agentId === agentIds[0] ? 'lead' : 'member',
        runtimeOwner: { machineId: MACHINE_ID, instanceId: service.requireOwnershipInstanceId() },
      });
      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent });
    }
  }

  /**
   * Announce the exact adapter incarnation recovery resolves and the local
   * authority owns. Recovery must only dispatch through this live-identity
   * seam; a deterministic ID alone proves neither a process nor its owner.
   */
  async function publishLiveTestAdapter(): Promise<void> {
    const { adapterId } = await MakaioBus.request(AdapterRuntimeSubjects.resolveId, {
      adapterName: 'test-adapter',
      machineId: MACHINE_ID,
    });
    await MakaioBus.emit(AdapterSubjects.initialized, {
      adapterId,
      adapterName: 'test-adapter',
      machineId: MACHINE_ID,
      ownerInstanceId: service.requireOwnershipInstanceId(),
      capabilities: [],
    });
  }

  /**
   * Start the real guarded reservation that a remote recovery leaves in storage.
   *
   * This deliberately bypasses the local exclusive-start registry: the test is
   * exercising what a different process observes after the reservation has
   * persisted, not what a second send in this process joins.
   * @param agentId - Agent whose persisted recovery snapshot is reserved.
   * @param ownerInstanceId - Authority incarnation that owns this recovery.
   * @param resumeProviderSessionId - Provider key to reserve, or `null` for a fresh recovery.
   * @returns The real reserved-rehydrate lifecycle.
   */
  async function startForeignReservedRehydrate(
    agentId: string,
    ownerInstanceId: string,
    resumeProviderSessionId: string | null,
  ): Promise<ReservedRehydrateOutcome> {
    const snapshot = await readRecoveryPlanningSnapshot(MakaioBus, agentId);
    if (snapshot === null) throw new Error(`expected recovery snapshot for ${agentId}`);
    const { adapterId } = await MakaioBus.request(AdapterRuntimeSubjects.resolveId, {
      adapterName: snapshot.agent.adapterName,
      machineId: MACHINE_ID,
    });
    const instance = { adapterId, machineId: MACHINE_ID, ownerInstanceId };
    const recoveryGuard = await buildRecoveryReservationGuard(MakaioBus, snapshot, instance, resumeProviderSessionId);
    return runReservedRehydrate(MakaioBus, {
      agent: snapshot.agent,
      sessionId: snapshot.agent.sessionId,
      instance,
      resumeProviderSessionId,
      recoveryGuard,
    });
  }

  it('routes concurrent messages for one dead agent on a single turn', async () => {
    const sessionId = 'session-recovery-overlap';
    await seedSession(sessionId, ['agent-1', 'agent-2']);
    registerDeadAgentProbe(sessionId);

    const firstRehydrateStarted = createDeferred<void>();
    const releaseFirstRehydrate = createDeferred<void>();
    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      rehydrateCallCount += 1;
      rehydratedAgentIds.add(ctx.payload.agentId);
      if (rehydrateCallCount === 1) {
        firstRehydrateStarted.resolve();
        await releaseFirstRehydrate.promise;
      }
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });

    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const first = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'overlap-superset',
      agentIds: ['agent-1', 'agent-2'],
    });
    await firstRehydrateStarted.promise;
    const second = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'overlap-subset',
      agentIds: ['agent-1'],
    });
    // Drained before the first rehydrate is released, so the second send has
    // provably reached the agent it shares with the first while that agent's
    // attempt is still open. Releasing straight away would let the entry clear
    // first and turn the assertion below into a coin toss.
    await settleEventLoop();
    releaseFirstRehydrate.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    // One lifecycle for one agent identity: the reserved recovery moved the row
    // to `starting`, so the second send resolved that in-flight start — waiting
    // for it and then using the agent it produced — instead of dispatching a
    // second rehydrate at the same connector.
    expect(rehydrateCallCount).toBe(1);
    expect(firstResult.turnId).toBe(secondResult.turnId);
    expect(sent).toEqual(
      expect.arrayContaining([
        { agentId: 'agent-1', message: 'overlap-superset' },
        { agentId: 'agent-2', message: 'overlap-superset' },
        { agentId: 'agent-1', message: 'overlap-subset' },
      ]),
    );
    expect(sent).toHaveLength(3);
  });

  it('joins an in-flight start for a dead agent instead of dispatching a second rehydrate', async () => {
    const sessionId = 'session-recovery-join';
    await seedSession(sessionId, ['agent-1']);
    registerDeadAgentProbe(sessionId);

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    // Something else in this process is already rebuilding agent-1 — a restart,
    // or another send that got there first. The lifecycle is exclusive per agent
    // identity, so the send must wait for that attempt rather than open a second
    // one beside it.
    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await attempt.promise;
      // The attempt succeeded: it rebuilt the connector this send needs.
      return 'connected';
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'joins-the-attempt',
      agentIds: ['agent-1'],
    });
    try {
      await settleEventLoop();
      expect(rehydrateCallCount).toBe(0);
      expect(sent).toHaveLength(0);
    } finally {
      // Opened whatever the assertions above did: the registry is process-wide,
      // so a failed expectation must not leave this agent's entry pending for
      // every test that follows.
      attempt.resolve();
    }
    await inFlight.settled;
    await send;
    // Still nothing dispatched — and the reason is the *row*, not the absence of
    // a rejection: the attempt left it `idle`, which is the one classification
    // that says an agent is usable as it stands.
    expect(await readStatus('agent-1')).toBe('idle');
    expect(rehydrateCallCount).toBe(0);
    expect(sent).toEqual([{ agentId: 'agent-1', message: 'joins-the-attempt' }]);
  });

  it('recovers for itself when the attempt it joined left the row dead', async () => {
    // The attempt resolved normally and built nothing — it was refused, it
    // deferred, or it lost its own arbitration. Reading that as this send's own
    // success would route a turn at an agent with no connector behind it.
    const sessionId = 'session-recovery-join-dead';
    await seedSession(sessionId, ['agent-1']);
    registerDeadAgentProbe(sessionId);

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      rehydratedAgentIds.add(ctx.payload.agentId);
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
    const recoveryClaims: Array<{ guard: unknown; result: unknown }> = [];
    unsubscribers.push(
      MakaioBus.on(
        SessionOwnershipStorageSubjects.claim,
        async (ctx) => {
          await ctx.next();
          if (ctx.payload.recoveryGuard !== undefined) {
            recoveryClaims.push({ guard: ctx.payload.recoveryGuard, result: ctx.result });
          }
        },
        { priority: 100 },
      ),
    );

    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await attempt.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'dead' });
      return 'no-connector';
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'joins-then-recovers',
      agentIds: ['agent-1'],
    });
    try {
      await settleEventLoop();
    } finally {
      attempt.resolve();
    }
    await inFlight.settled;
    await settleEventLoop();
    await send;

    // One bounded re-entry: this send asked the question for itself and got an
    // authoritative answer, rather than reporting somebody else's non-answer.
    expect(rehydrateCallCount).toBe(1);
    expect(recoveryClaims).toEqual([
      {
        guard: expect.objectContaining({
          expectedStatus: 'dead',
          expectedPreimage: expect.objectContaining({ status: 'dead', adapterId: 'adapter-agent-1' }),
        }),
        result: expect.objectContaining({ outcome: 'claimed' }),
      },
    ]);
    expect(sent).toEqual([{ agentId: 'agent-1', message: 'joins-then-recovers' }]);
  });

  it('does not open a second lifecycle beside a live start it out-raced', async () => {
    // The cross-process case. A live peer holds a `starting` row; this process
    // has no joinable entry for it — a dead process would leave none either —
    // so the send wins the compare-and-swap. That says it wrote a status first,
    // nothing more: the attempt it outran may be alive and about to land, and
    // Wave 3 cannot ask whether that process still exists (OQ-B). What it can
    // ask is whether a *connector* answers, and here one does.
    const sessionId = 'session-live-peer';
    await seedSession(sessionId, ['agent-1']);
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'starting' });
    // The peer's start landed: its connector is registered and answers.
    probeUnsub?.();
    probeUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      ctx.setResult({
        agent: { agentId: ctx.payload.agentId, sessionId, adapterSessionId: 'provider-peer' },
      });
    });

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'races a live peer',
      agentIds: ['agent-1'],
    });

    // No second lifecycle: the send used the connector the peer built rather
    // than rebuilding one beside it.
    expect(rehydrateCallCount).toBe(0);
    expect(sent).toEqual([{ agentId: 'agent-1', message: 'races a live peer' }]);
    // **And the claim it wrote to arbitrate is taken back.** The
    // compare-and-swap had to run before anything could ask whether a connector
    // exists — that write *is* the cross-process claim — so the veto leaves a
    // `dead` row on an agent that is serving turns. Nothing else lifts it: the
    // per-turn activity stamp moves a row only between `idle` and `active`.
    expect(await readStatus('agent-1')).toBe('idle');

    // Which is what the next send needs: it re-reads the row, finds a usable
    // agent instead of a recoverable one, and neither arbitrates nor rebuilds.
    await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'the send after the veto',
      agentIds: ['agent-1'],
    });
    expect(rehydrateCallCount).toBe(0);
    expect(await readStatus('agent-1')).toBe('idle');
    expect(sent).toEqual([
      { agentId: 'agent-1', message: 'races a live peer' },
      { agentId: 'agent-1', message: 'the send after the veto' },
    ]);
  });

  it('still recovers an out-raced start whose adapter cannot answer', async () => {
    // The other half, and why the probe may only veto. An owning process that
    // really died leaves no joinable entry *and* no adapter to ask — reading an
    // unanswerable probe as "alive" would strand the agent with nobody
    // rebuilding it, which is the case the compare-and-swap rule exists for.
    const sessionId = 'session-dead-peer';
    await seedSession(sessionId, ['agent-1']);
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'starting' });
    probeUnsub?.();

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'races a dead peer',
      agentIds: ['agent-1'],
    });

    expect(rehydrateCallCount).toBe(1);
    expect(sent).toEqual([{ agentId: 'agent-1', message: 'races a dead peer' }]);
  });

  it('never hands on a row no storage holds', async () => {
    // The arbitration is a compare-and-swap on agent storage, and the session
    // package does not depend on that storage existing. Where the subject is
    // unhandled nothing was written, so there is no `dead` row to hand on — the
    // send still owns the recovery (the reserved recovery treats an absent row
    // the same way), but the identity it carries forward has to be one somebody
    // actually holds. Driven on a bare bus, which is exactly that composition.
    const bare = createBusInstance();
    const agentId = `agent-no-storage-${crypto.randomUUID()}`;
    const agent = createTestAgent(agentId, {
      sessionId: 'session-no-storage',
      status: 'starting',
      runtimeOwner: { machineId: MACHINE_ID, instanceId: service.requireOwnershipInstanceId() },
    });
    const session = createMockSession({ sessionId: 'session-no-storage', agents: [agent], leadAgentId: agentId });

    const resolution = await resolveInFlightStarts(bare, session);

    // Recovered, not dropped: an absent arbiter is not evidence the agent is gone.
    expect([...resolution.recoveringAgentIds]).toEqual([agentId]);
    expect([...resolution.droppedAgentIds]).toEqual([]);
    // And the row is the caller's own, not a `dead` one invented for it.
    expect(session.agents[0]?.status).toBe('starting');
  });

  it('carries the joined attempt\u2019s adapter binding into the session it hands on', async () => {
    // Two questions come off one read, and both have to be answered. The
    // resolution classifies the row's *state* to decide what this send does —
    // and the row's *identity* is what the send then probes and routes at. A
    // joined attempt can bind its agent to a different adapter instance, so a
    // send left on the pre-join snapshot would address the instance that attempt
    // moved off.
    const sessionId = 'session-rebound-by-join';
    await seedSession(sessionId, ['agent-1']);
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'starting' });
    const read = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
    if (!read) throw new Error('seeded session is missing');
    // Detached explicitly, which is what a send holds: a snapshot taken before
    // the attempt ran. Both backends materialise their reads now, so the copy is
    // no longer a workaround for one of them handing out its stored row — it
    // states what the case is about, which is that nothing refreshes this
    // snapshot except the join.
    const session: IMakaioSession = { ...read, agents: read.agents.map((agent) => ({ ...agent })) };
    expect(session.agents[0]?.adapterId).not.toBe('rebound-adapter');

    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await attempt.promise;
      await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
        agentId: 'agent-1',
        adapterId: 'rebound-adapter',
      });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'idle' });
      return 'connected';
    });

    const resolving = resolveInFlightStarts(MakaioBus, session);
    attempt.resolve();
    await inFlight.settled;
    const resolution = await resolving;

    expect([...resolution.droppedAgentIds]).toEqual([]);
    // The session now carries what the attempt established, not what this send
    // read before it joined.
    expect(session.agents[0]?.adapterId).toBe('rebound-adapter');
    expect(session.agents[0]?.status).toBe('idle');
  });

  it('refreshes a dead sibling after joining another agent start before deciding to recover it', async () => {
    // `sendMessage` materialises every agent row before resolving any start.
    // While it waits for agent-1, another lifecycle can make agent-2 live on a
    // new adapter instance. Keeping agent-2's old `dead` row would probe the
    // old instance, get no connector, and open a replacement lifecycle beside
    // the one that just landed.
    const sessionId = 'session-joined-start-refreshes-sibling';
    await seedSession(sessionId, ['agent-1', 'agent-2']);
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'starting' });
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'dead' });

    probeUnsub?.();
    probeUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      if (ctx.payload.agentId === 'agent-2' && ctx.payload.adapterId !== 'agent-2-live') {
        ctx.setResult({ agent: null });
        return;
      }
      ctx.setResult({
        agent: { agentId: ctx.payload.agentId, sessionId, adapterSessionId: `provider-${ctx.payload.agentId}` },
      });
    });

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();

    const releaseStart = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await releaseStart.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'idle' });
      await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
        agentId: 'agent-2',
        adapterId: 'agent-2-live',
      });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'idle' });
      return 'connected';
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'uses-the-sibling-that-landed',
      agentIds: ['agent-2'],
    });
    try {
      await settleEventLoop();
    } finally {
      releaseStart.resolve();
    }
    await inFlight.settled;
    await send;

    expect(rehydrateCallCount).toBe(0);
    expect(sent).toEqual([{ agentId: 'agent-2', message: 'uses-the-sibling-that-landed' }]);
  });

  it('arbitrates a sibling that becomes starting while a local join waits', async () => {
    // The send materialized agent-2 as dead, so the first pass deliberately
    // skips it. While agent-1's local start holds the send, a peer claims
    // agent-2 and leaves it `starting` without a local in-flight entry. The
    // refresh must not hand that raw row to probe/recovery: it needs the same
    // compare-and-swap arbitration and provenance as an originally starting row.
    const sessionId = 'session-joined-start-refreshes-starting-sibling';
    await seedSession(sessionId, ['agent-1', 'agent-2']);
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'starting' });
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'dead' });
    const read = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
    if (!read) throw new Error('seeded session is missing');
    const session: IMakaioSession = { ...read, agents: read.agents.map((agent) => ({ ...agent })) };

    const releaseStart = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await releaseStart.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'idle' });
      return 'connected';
    });

    const resolving = resolveInFlightStarts(MakaioBus, session);
    try {
      await settleEventLoop();
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'starting' });
    } finally {
      releaseStart.resolve();
    }
    await inFlight.settled;
    const resolution = await resolving;

    // Agent-2 was not left as the raw refreshed `starting` row: the no-local-
    // entry branch arbitrated it to dead, and recovery therefore receives both
    // its durable preimage and its cross-process provenance.
    expect([...resolution.droppedAgentIds]).toEqual([]);
    expect([...resolution.recoveringAgentIds]).toEqual(['agent-2']);
    expect([...resolution.arbitratedAgentIds]).toEqual(['agent-2']);
    expect(session.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'agent-1', status: 'idle' }),
        expect.objectContaining({ agentId: 'agent-2', status: 'dead' }),
      ]),
    );
    expect(await readStatus('agent-2')).toBe('dead');
  });

  it('defers a foreign guarded recovery without probing or finalizing it', async () => {
    const sessionId = 'session-foreign-guarded-recovery';
    const agentId = 'agent-1';
    await seedSession(sessionId, [agentId]);
    const resumeProviderSessionId = `provider-${agentId}`;
    await MakaioBus.request(AgentStorageSubjects.delete, { agentId });
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        adapterSessionId: resumeProviderSessionId,
        status: 'dead',
        runtimeOwner: { machineId: MACHINE_ID, instanceId: service.requireOwnershipInstanceId() },
      }),
    });
    let finalized = 0;
    let probed = 0;
    let rehydrated = 0;
    let stopped = 0;
    const firstRehydrateEntered = createDeferred<void>();
    const releaseFirstRehydrate = createDeferred<void>();
    unsubscribers.push(
      MakaioBus.on(
        SessionOwnershipStorageSubjects.finalizeRecovery,
        async (ctx) => {
          finalized += 1;
          await ctx.next();
        },
        { priority: 100 },
      ),
    );
    unsubscribers.push(
      MakaioBus.on(
        AdapterSubjects.stopAgent,
        async (ctx) => {
          stopped += 1;
          await ctx.next();
        },
        { priority: 100 },
      ),
    );
    probeUnsub?.();
    probeUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      probed += 1;
      ctx.setResult({ agent: null });
    });
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      rehydrated += 1;
      firstRehydrateEntered.resolve();
      await releaseFirstRehydrate.promise;
      ctx.setResult({ success: false, dispatch: 'not-dispatched', message: 'foreign recovery remains in flight' });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);

    const foreignRecovery = startForeignReservedRehydrate(
      agentId,
      service.requireOwnershipInstanceId(),
      resumeProviderSessionId,
    );
    await firstRehydrateEntered.promise;

    const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'must-not-touch-foreign-recovery',
      agentIds: [agentId],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      cause: { code: 'agent-unavailable', deferredAgentIds: [agentId] },
    });

    expect(finalized).toBe(0);
    expect(probed).toBe(0);
    // The only rehydrate is the remote reservation used to create the real
    // guarded row; the send opened none of its own.
    expect(rehydrated).toBe(1);
    expect(stopped).toBe(0);
    expect(sent).toEqual([]);
    const { agent } = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
    expect(agent).toMatchObject({
      status: 'starting',
      runtimeOwner: { machineId: MACHINE_ID, instanceId: service.requireOwnershipInstanceId() },
    });
    releaseFirstRehydrate.resolve();
    await foreignRecovery;
  });

  it('finalizes only a retired guarded recovery before one ordinary recovery proceeds', async () => {
    const sessionId = 'session-retired-guarded-recovery';
    const agentId = 'agent-retired-guarded-recovery';
    await seedSession(sessionId, [agentId]);
    const resumeProviderSessionId = `provider-${agentId}`;
    await MakaioBus.request(AgentStorageSubjects.delete, { agentId });
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        adapterSessionId: resumeProviderSessionId,
        status: 'dead',
        runtimeOwner: { machineId: MACHINE_ID, instanceId: service.requireOwnershipInstanceId() },
      }),
    });
    const firstRehydrateEntered = createDeferred<void>();
    const releaseFirstRehydrate = createDeferred<void>();
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      firstRehydrateEntered.resolve();
      await releaseFirstRehydrate.promise;
      ctx.setResult({ success: false, dispatch: 'not-dispatched', message: 'the retired runtime never dispatched' });
    });

    const retiredOwnerInstanceId = service.requireOwnershipInstanceId();
    const firstRecovery = startForeignReservedRehydrate(agentId, retiredOwnerInstanceId, null);
    await firstRehydrateEntered.promise;
    const guarded = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
    const guardedAgent = guarded.agent;
    if (guardedAgent === null || guardedAgent.recoveryAttemptId === undefined) {
      throw new Error('expected the real reservation attempt fence');
    }
    const retiredAttemptId = guardedAgent.recoveryAttemptId;
    expect(guardedAgent.runtimeOwner).toEqual({ machineId: MACHINE_ID, instanceId: retiredOwnerInstanceId });
    // The authority records retirement only after real teardown evidence; a
    // made-up runtime row would not exercise the ownership lifecycle this
    // consumer relies on.
    await MakaioBus.emit(AdapterRuntimeSubjects.teardownCompleted, {
      ownerInstanceId: retiredOwnerInstanceId,
      evidence: 'released',
    });
    await MakaioBus.emit(AdapterSubjects.deinitialized, {
      adapterId: guardedAgent.adapterId,
      adapterName: guardedAgent.adapterName,
      machineId: MACHINE_ID,
      ownerInstanceId: retiredOwnerInstanceId,
    });
    await service.destroy();
    const optionalRetired = await MakaioBus.requestOptional(SessionOwnershipStorageSubjects.getRuntimeInstance, {
      instanceId: retiredOwnerInstanceId,
      machineId: MACHINE_ID,
    });
    expect(optionalRetired).toMatchObject({ handled: true, data: { instance: { retiredAt: expect.any(Number) } } });
    expect((await MakaioBus.request(AgentStorageSubjects.get, { agentId })).agent).toMatchObject({
      status: 'starting',
      recoveryAttemptId: retiredAttemptId,
      runtimeOwner: { machineId: MACHINE_ID, instanceId: retiredOwnerInstanceId },
    });

    const finalizations: Array<{ attemptId: string; action: string }> = [];
    unsubscribers.push(
      MakaioBus.on(
        SessionOwnershipStorageSubjects.finalizeRecovery,
        async (ctx) => {
          finalizations.push({ attemptId: ctx.payload.attemptId, action: ctx.payload.action.kind });
          await ctx.next();
        },
        { priority: 100 },
      ),
    );
    let recoveryDispatches = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      recoveryDispatches += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    probeUnsub?.();
    probeUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      ctx.setResult({ agent: null });
    });
    orchestrator.destroy();
    service = new MakaioSessionService(MakaioBus, { machineId: MACHINE_ID });
    await service.init();
    orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
    await publishLiveTestAdapter();
    const sent = registerSendCapture();
    await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'recover exactly once',
      agentIds: [agentId],
    });
    expect(finalizations[0]).toEqual({ attemptId: retiredAttemptId, action: 'failed' });
    expect(recoveryDispatches).toBe(1);
    expect(sent).toEqual([{ agentId, message: 'recover exactly once' }]);
    expect((await MakaioBus.request(AgentStorageSubjects.get, { agentId })).agent).toMatchObject({ status: 'idle' });
    releaseFirstRehydrate.resolve();
    await firstRecovery;
  });

  it('does not let a retired attempt finalizer overwrite a superseding guarded recovery', async () => {
    const sessionId = 'session-stale-retired-finalizer';
    const agentId = 'agent-stale-retired-finalizer';
    await seedSession(sessionId, [agentId]);
    const resumeProviderSessionId = `provider-${agentId}`;
    await MakaioBus.request(AgentStorageSubjects.delete, { agentId });
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        adapterSessionId: resumeProviderSessionId,
        status: 'dead',
        runtimeOwner: { machineId: MACHINE_ID, instanceId: service.requireOwnershipInstanceId() },
      }),
    });
    const firstRehydrateEntered = createDeferred<void>();
    const releaseFirstRehydrate = createDeferred<void>();
    let rehydrateCalls = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      rehydrateCalls += 1;
      if (rehydrateCalls === 1) {
        firstRehydrateEntered.resolve();
        await releaseFirstRehydrate.promise;
        ctx.setResult({ success: false, dispatch: 'not-dispatched', message: 'stale owner did not dispatch' });
        return;
      }
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const stopped: string[] = [];
    unsubscribers.push(
      MakaioBus.on(
        AdapterSubjects.stopAgent,
        async (ctx) => {
          stopped.push(ctx.payload.agentId);
          await ctx.next();
        },
        { priority: 100 },
      ),
    );

    const retiredOwnerInstanceId = service.requireOwnershipInstanceId();
    const firstRecovery = startForeignReservedRehydrate(agentId, retiredOwnerInstanceId, resumeProviderSessionId);
    await firstRehydrateEntered.promise;
    const guarded = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
    const guardedAgent = guarded.agent;
    if (guardedAgent === null || guardedAgent.recoveryAttemptId === undefined) {
      throw new Error('expected the first real reservation attempt fence');
    }
    const retiredAttemptId = guardedAgent.recoveryAttemptId;
    expect(guardedAgent.runtimeOwner).toEqual({ machineId: MACHINE_ID, instanceId: retiredOwnerInstanceId });
    await MakaioBus.emit(AdapterRuntimeSubjects.teardownCompleted, {
      ownerInstanceId: retiredOwnerInstanceId,
      evidence: 'released',
    });
    await MakaioBus.emit(AdapterSubjects.deinitialized, {
      adapterId: guardedAgent.adapterId,
      adapterName: guardedAgent.adapterName,
      machineId: MACHINE_ID,
      ownerInstanceId: retiredOwnerInstanceId,
    });
    await service.destroy();
    orchestrator.destroy();
    service = new MakaioSessionService(MakaioBus, { machineId: MACHINE_ID });
    await service.init();
    orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
    await publishLiveTestAdapter();

    let supersedingOutcome: ReservedRehydrateOutcome | undefined;
    unsubscribers.push(
      MakaioBus.on(
        SessionOwnershipStorageSubjects.finalizeRecovery,
        async (ctx) => {
          if (ctx.payload.attemptId === retiredAttemptId) {
            // This reservation transaction claims the current guarded row, so
            // the stale finalizer reaches storage only after a newer attempt
            // owns the row. No synthetic guarded row or direct state mutation
            // can establish that ordering.
            supersedingOutcome = await startForeignReservedRehydrate(
              agentId,
              service.requireOwnershipInstanceId(),
              resumeProviderSessionId,
            );
          }
          await ctx.next();
        },
        { priority: 100 },
      ),
    );

    probeUnsub?.();
    probeUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      ctx.setResult({ agent: { agentId: ctx.payload.agentId, sessionId, adapterSessionId: resumeProviderSessionId } });
    });
    const sent = registerSendCapture();
    await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'uses the superseding recovery',
      agentIds: [agentId],
    });
    expect(supersedingOutcome).toMatchObject({ kind: 'rehydrated' });
    expect(rehydrateCalls).toBe(2);
    expect(sent).toEqual([{ agentId, message: 'uses the superseding recovery' }]);
    expect((await MakaioBus.request(AgentStorageSubjects.get, { agentId })).agent).toMatchObject({ status: 'idle' });
    expect(stopped).toEqual([]);

    releaseFirstRehydrate.resolve();
    await firstRecovery;
    expect(stopped).toEqual([]);
  });

  it('restarts the sibling refresh after a later local join', async () => {
    // Agent-2 is read before agent-3. Joining agent-3 must therefore restart
    // the entire refresh pass: its start rebinds agent-2 while the join waits,
    // and the send must probe the final identity rather than the earlier row.
    const sessionId = 'session-joined-start-stable-sibling-refresh';
    await seedSession(sessionId, ['agent-1', 'agent-2', 'agent-3']);
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'starting' });
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'dead' });
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-3', status: 'dead' });

    const probedAgent2AdapterIds: string[] = [];
    probeUnsub?.();
    probeUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      if (ctx.payload.agentId === 'agent-2') {
        probedAgent2AdapterIds.push(ctx.payload.adapterId);
      }
      ctx.setResult({
        agent: {
          agentId: ctx.payload.agentId,
          sessionId,
          adapterSessionId: `provider-${ctx.payload.agentId}`,
        },
      });
    });
    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);

    const agent2FirstRefresh = createDeferred<void>();
    let observedAgent2Refresh = false;
    unsubscribers.push(
      MakaioBus.on(
        AgentStorageSubjects.get,
        async (ctx) => {
          await ctx.next();
          if (!observedAgent2Refresh && ctx.payload.agentId === 'agent-2') {
            observedAgent2Refresh = true;
            agent2FirstRefresh.resolve();
          }
        },
        { priority: 100 },
      ),
    );

    const releaseFirstStart = createDeferred<void>();
    const firstStart = runExclusiveStart('agent-1', async () => {
      await releaseFirstStart.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'idle' });
      return 'connected';
    });
    const releaseLaterStart = createDeferred<void>();
    const laterStart = runExclusiveStart('agent-3', async () => {
      await releaseLaterStart.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-3', status: 'idle' });
      await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
        agentId: 'agent-2',
        adapterId: 'agent-2-final',
      });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'idle' });
      return 'connected';
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'uses-the-final-sibling-identity',
      agentIds: ['agent-2'],
    });
    try {
      await settleEventLoop();
      await MakaioBus.request(AgentStorageSubjects.updateRuntime, {
        agentId: 'agent-2',
        adapterId: 'agent-2-first-refresh',
      });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'idle' });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-3', status: 'starting' });
      releaseFirstStart.resolve();
      await firstStart.settled;
      await agent2FirstRefresh.promise;
      await settleEventLoop();
    } finally {
      releaseFirstStart.resolve();
      releaseLaterStart.resolve();
    }
    await laterStart.settled;
    await send;

    expect(rehydrateCallCount).toBe(0);
    expect(probedAgent2AdapterIds).toEqual(['agent-2-final']);
    expect(sent).toEqual([{ agentId: 'agent-2', message: 'uses-the-final-sibling-identity' }]);
    const { agent: storedAgent2 } = await MakaioBus.request(AgentStorageSubjects.get, { agentId: 'agent-2' });
    expect(storedAgent2).toMatchObject({ adapterId: 'agent-2-final', status: 'idle' });
  });

  it('bounds refresh passes invalidated by fresh local starts', async () => {
    // Each start lands after its row's position in the preceding pass: agent-2
    // invalidates pass one, agent-3 invalidates pass two, and agent-4
    // invalidates pass three. The latter exceeds the shared contention bound,
    // so the send fails deterministically instead of waiting for a stable pass
    // that a local producer can keep invalidating forever.
    const sessionId = 'session-joined-start-refresh-pass-bound';
    await seedSession(sessionId, ['agent-1', 'agent-2', 'agent-3', 'agent-4']);
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'starting' });
    for (const agentId of ['agent-2', 'agent-3', 'agent-4']) {
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'dead' });
    }
    const read = (await MakaioBus.request(SessionSubjects.get, { sessionId })).session;
    if (!read) throw new Error('seeded session is missing');
    const agent = (agentId: string): MakaioSessionAgent => {
      const found = read.agents.find((candidate) => candidate.agentId === agentId);
      if (!found) throw new Error(`seeded agent ${agentId} is missing`);
      return { ...found };
    };
    // Reverse the chained starters so each successor is passed before the
    // predecessor's join can publish it as `starting`.
    const session: IMakaioSession = {
      ...read,
      agents: [agent('agent-1'), agent('agent-4'), agent('agent-3'), agent('agent-2')],
    };

    const agent2Observed = createDeferred<void>();
    const agent3Observed = createDeferred<void>();
    const agent4Observed = createDeferred<void>();
    const reads = new Map<string, number>();
    unsubscribers.push(
      MakaioBus.on(
        AgentStorageSubjects.get,
        async (ctx) => {
          await ctx.next();
          const count = (reads.get(ctx.payload.agentId) ?? 0) + 1;
          reads.set(ctx.payload.agentId, count);
          if (ctx.payload.agentId === 'agent-2' && count === 1) agent2Observed.resolve();
          if (ctx.payload.agentId === 'agent-3' && count === 2) agent3Observed.resolve();
          if (ctx.payload.agentId === 'agent-4' && count === 3) agent4Observed.resolve();
        },
        { priority: 100 },
      ),
    );

    const releaseAgent1 = createDeferred<void>();
    const firstStart = runExclusiveStart('agent-1', async () => {
      await releaseAgent1.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'idle' });
      return 'connected';
    });
    const releaseAgent2 = createDeferred<void>();
    const secondStart = runExclusiveStart('agent-2', async () => {
      await releaseAgent2.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'idle' });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-3', status: 'starting' });
      return 'connected';
    });
    const releaseAgent3 = createDeferred<void>();
    const thirdStart = runExclusiveStart('agent-3', async () => {
      await releaseAgent3.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-3', status: 'idle' });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-4', status: 'starting' });
      return 'connected';
    });
    const releaseAgent4 = createDeferred<void>();
    const fourthStart = runExclusiveStart('agent-4', async () => {
      await releaseAgent4.promise;
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-4', status: 'idle' });
      return 'connected';
    });

    const resolving = resolveInFlightStarts(MakaioBus, session);
    try {
      await settleEventLoop();
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-2', status: 'starting' });
      releaseAgent1.resolve();
      await firstStart.settled;
      await agent2Observed.promise;
      await settleEventLoop();
      releaseAgent2.resolve();
      await secondStart.settled;
      await agent3Observed.promise;
      await settleEventLoop();
      releaseAgent3.resolve();
      await thirdStart.settled;
      await agent4Observed.promise;
      await settleEventLoop();
    } finally {
      releaseAgent1.resolve();
      releaseAgent2.resolve();
      releaseAgent3.resolve();
      releaseAgent4.resolve();
    }
    await fourthStart.settled;
    await expect(resolving).rejects.toMatchObject({
      code: 'start-unresolved',
      message: expect.stringContaining('did not stabilize after 2 joined refresh passes'),
    });
  });

  it('recovers for itself when the attempt it joined rolled the row back to idle', async () => {
    // The interaction between the two rules. A recovery that ends in a modeled
    // non-success — deferred, or refused before dispatch — puts the row back
    // where its claim found it, which for a live-looking agent is `idle`. That
    // row reads *usable*, and it is: as a description of the identity. It says
    // nothing about a connector, and this attempt built none.
    const sessionId = 'session-recovery-join-rolled-back';
    await seedSession(sessionId, ['agent-1']);
    registerDeadAgentProbe(sessionId);

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      rehydratedAgentIds.add(ctx.payload.agentId);
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await attempt.promise;
      // Exactly what the rollback rule leaves behind: the row untouched, at the
      // `idle` the claim swapped out and swapped back.
      return 'no-connector';
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'joins-a-rolled-back-attempt',
      agentIds: ['agent-1'],
    });
    try {
      await settleEventLoop();
    } finally {
      attempt.resolve();
    }
    await inFlight.settled;
    await send;

    // The row would have said `use`. The verdict says otherwise, and it wins.
    expect(await readStatus('agent-1')).toBe('idle');
    expect(rehydrateCallCount).toBe(1);
    expect(sent).toEqual([{ agentId: 'agent-1', message: 'joins-a-rolled-back-attempt' }]);
  });

  it('keeps the connector behind a starting row whose attempt built none', async () => {
    // Why this rule reads the row and **not** the attempt's verdict. A recovery
    // that deferred or was refused reports `no-connector` truthfully — *it*
    // built none — and puts the row back at the `idle` its claim swapped out.
    // That row can have a perfectly live connector behind it: the reservation
    // refused because another generation owns the provider session, not because
    // this agent lost anything. Reading the verdict here would put the agent in
    // the recovering set, which this send rebuilds **without probing**, and a
    // rehydrate dispatched onto a live connector replaces it.
    const sessionId = 'session-starting-rolled-back';
    await seedSession(sessionId, ['agent-1']);
    await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'starting' });
    probeUnsub?.();
    probeUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      ctx.setResult({
        agent: { agentId: ctx.payload.agentId, sessionId, adapterSessionId: 'provider-live' },
      });
    });

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);

    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await attempt.promise;
      // The rollback rule, verbatim: the row returns to the status the claim
      // swapped out, and this attempt reports that it built nothing.
      await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId: 'agent-1',
        status: 'idle',
        expectedStatus: ['starting'],
      });
      return 'no-connector';
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'joins-a-starting-row',
      agentIds: ['agent-1'],
    });
    try {
      await settleEventLoop();
    } finally {
      attempt.resolve();
    }
    await inFlight.settled;
    await send;

    // The liveness probe is what answers the connector question, and it found
    // one. Nothing was rebuilt over it.
    expect(rehydrateCallCount).toBe(0);
    expect(sent).toEqual([{ agentId: 'agent-1', message: 'joins-a-starting-row' }]);
  });

  it('defers a recovery it cannot address in the machine it acts under', async () => {
    // The instance and the machine have to come from one identity. When no
    // instance of this agent's adapter is derivable for the machine this send
    // acts under, the persisted one cannot stand in: an instance ID is a
    // one-way hash of `(machine, adapter)`, so the machine it belongs to cannot
    // be recovered from it. Reserving under this machine and dispatching at that
    // instance would file the claim under a pair no other actor computes — a key
    // that collides with nothing protects nothing.
    const sessionId = 'session-unresolvable-instance';
    await seedSession(sessionId, ['agent-1', 'agent-2']);
    registerDeadAgentProbe(sessionId);
    unsubscribers.push(
      MakaioBus.on(
        AdapterRuntimeSubjects.resolveId,
        () => {
          throw new Error('no adapter instance for this machine');
        },
        // Ahead of whatever else answers: the first registered handler wins.
        { priority: 100 },
      ),
    );

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);

    await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'delivered-to-the-drivable-one',
      agentIds: ['agent-1', 'agent-2'],
    });

    // Nothing dispatched and nothing claimed for the agent this runtime may not
    // act for; the send narrows to the agent it can drive rather than failing.
    expect(rehydrateCallCount).toBe(0);
    const { claims } = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId: MACHINE_ID,
    });
    expect(claims).toEqual([]);
    expect(sent).toEqual([{ agentId: 'agent-2', message: 'delivered-to-the-drivable-one' }]);
  });

  it.each([
    { label: 'disposed', dispose: true },
    { label: 'deleted', dispose: false },
  ])('fails the send when the attempt it joined left the row $label', async ({ dispose }) => {
    const sessionId = `session-recovery-join-${dispose ? 'disposed' : 'deleted'}`;
    await seedSession(sessionId, ['agent-1']);
    registerDeadAgentProbe(sessionId);

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await attempt.promise;
      if (dispose) {
        await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'agent-1', status: 'disposed' });
        return 'no-connector';
      }
      await MakaioBus.request(AgentStorageSubjects.delete, { agentId: 'agent-1' });
      return 'no-connector';
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'joins-a-removed-agent',
      agentIds: ['agent-1'],
    });
    try {
      await settleEventLoop();
    } finally {
      attempt.resolve();
    }
    await inFlight.settled;

    // Gone or terminal is unavailable, not recoverable: re-entering would
    // reserve and dispatch for an agent that no longer exists.
    await expect(send).rejects.toThrow(/agent-1/);
    expect(rehydrateCallCount).toBe(0);
    expect(sent).toEqual([]);
  });

  /**
   * Read one agent's stored lifecycle status.
   * @param agentId - Agent to read.
   * @returns The status, or `undefined` when the row is gone.
   */
  async function readStatus(agentId: string): Promise<string | undefined> {
    const { agent } = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
    return agent?.status;
  }

  /**
   * Report `agent-1` as gone and every other agent as live.
   * @param sessionId - Session the probed agents belong to.
   */
  function registerDeadAgentProbe(sessionId: string): void {
    probeUnsub?.();
    probeUnsub = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      if (ctx.payload.agentId === 'agent-1' && !rehydratedAgentIds.has('agent-1')) {
        ctx.setResult({ agent: null });
        return;
      }
      ctx.setResult({
        agent: {
          agentId: ctx.payload.agentId,
          sessionId,
          adapterSessionId: `adapter-session-${ctx.payload.agentId}`,
        },
      });
    });
  }

  /**
   * Capture every message routed to an agent.
   * @returns The growing capture list.
   */
  function registerSendCapture(): Array<{ agentId: string; message: string }> {
    const sent: Array<{ agentId: string; message: string }> = [];
    unsubscribers.push(
      MakaioBus.on(AgentSubjects.sendMessage, (ctx) => {
        const message =
          typeof ctx.payload.message === 'string' ? ctx.payload.message : JSON.stringify(ctx.payload.message);
        sent.push({ agentId: ctx.payload.agentId, message });
        ctx.setResult({ messageId: ctx.payload.messageId ?? crypto.randomUUID() });
      }),
    );
    return sent;
  }
  it('fails the send when the recovery it joined failed', async () => {
    // The rejection is this process's own verdict and outranks the row, which a
    // failed attempt only ever writes advisorily. Swallowing it would admit a
    // turn and persist a user message against an agent that cannot answer.
    const sessionId = 'session-recovery-joined-failure';
    await seedSession(sessionId, ['agent-1']);
    registerDeadAgentProbe(sessionId);

    let rehydrateCallCount = 0;
    rehydrateUnsub?.();
    rehydrateUnsub = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    // The attempt another send is already running for this agent, which fails.
    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await attempt.promise;
      throw new Error('connector refused to come back');
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'joins-a-failing-attempt',
      agentIds: ['agent-1'],
    });
    try {
      await settleEventLoop();
    } finally {
      attempt.resolve();
    }
    await inFlight.settled.catch(() => undefined);

    await expect(send).rejects.toThrow('was joined from another attempt');
    // Nothing was dispatched by this send, and nothing was routed to an agent
    // whose connector does not exist.
    expect(rehydrateCallCount).toBe(0);
    expect(sent).toEqual([]);
  });
});
