import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionOwnershipStorageSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession, MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { MakaioSessionService } from '../session-service.js';
import { runExclusiveStart } from '../ownership/in-flight-starts.js';
import { resolveInFlightStarts } from '../handlers/in-flight-start-join.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { registerMockStorageHandlers } from '../testing/index.js';
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
      });
      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent });
    }
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
      ctx.setResult({ success: true });
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
      ctx.setResult({ success: true });
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
      ctx.setResult({ success: true });
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

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
    await send;

    // One bounded re-entry: this send asked the question for itself and got an
    // authoritative answer, rather than reporting somebody else's non-answer.
    expect(rehydrateCallCount).toBe(1);
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
      ctx.setResult({ success: true });
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
      ctx.setResult({ success: true });
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
    const agent = createTestAgent(agentId, { sessionId: 'session-no-storage', status: 'starting' });
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
      ctx.setResult({ success: true });
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
      ctx.setResult({ success: true });
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
      ctx.setResult({ success: true });
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
      ctx.setResult({ success: true });
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
      ctx.setResult({ success: true });
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
