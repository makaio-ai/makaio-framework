/**
 * Tests for the reordered fresh lead start (Path A) and the in-flight-start
 * consumer rule a send applies before it probes anything.
 *
 * Everything runs against the real memory backends and the real ownership
 * authority through the real bus: the whole claim of the reordering is that the
 * designation, the claim and the status transition are durable in a particular
 * order, which a test that stubbed storage would assert nothing about. Only the
 * adapter is a stub — it is the thing being dispatched to, not the seam.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type AdapterSessionClaimRecord,
  type IMakaioSession,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { SessionStartError } from '../handlers/session-start-error.js';
import { startLeadAgent } from '../handlers/lead-start.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { resolveInFlightStarts } from '../handlers/in-flight-start-join.js';
import { resolveTargetAgents } from '../utils/session-utils.js';
import { runExclusiveStart } from '../ownership/index.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import { registerMemorySessionBackends, resetBusHandlers, waitForAsync } from './shared.js';

/** Runtime facts a caller can put on the start request under test. */
interface LeadStartRuntimeFields {
  /** Model the agent runs. */
  model?: string;
  /** Working directory the agent runs in. */
  cwd?: string;
  /** Directories the agent may reach outside its cwd. */
  allowedDirectories?: string[];
  /** Client package the start belongs to. */
  clientId?: string;
  /** Harness the tool policy is resolved against. */
  harnessId?: string;
}

const MACHINE_ID = 'lead-start-machine';
const ADAPTER_NAME = 'test-adapter';
const ADAPTER_ID = 'test-adapter-instance';

/** What a stubbed `adapter.startAgent` does when the start reaches it. */
interface StartAgentStub {
  /** Provider session the adapter reports, or `null` for an idle start. */
  adapterSessionId?: string | null;
  /** Refuse instead of starting, with this disposition. */
  refuseWith?: 'not-dispatched' | 'dispatch-uncertain';
  /** Throw instead of answering. */
  throwWith?: string;
  /** Runs while the dispatch is in flight, before the adapter answers. */
  duringDispatch?: (agentId: string) => Promise<void>;
}

describe('reserved fresh lead start', () => {
  let service: MakaioSessionService;
  let cleanups: Array<() => void> = [];
  let stoppedAgentIds: string[];
  let rehydratedAgentIds: string[];

  beforeEach(async () => {
    resetBusHandlers();
    stoppedAgentIds = [];
    rehydratedAgentIds = [];
    cleanups = [
      ...registerMemorySessionBackends(MakaioBus),
      registerMemorySessionEventStorage(MakaioBus),
      // The agent and session rows come from the real backend above; only the
      // turn/message/routing surface is stubbed.
      registerMockStorageHandlers({ omit: ['agent', 'session'] }),
      MakaioBus.on(AdapterSubjects.stopAgent, (ctx) => {
        stoppedAgentIds.push(ctx.payload.agentId);
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydratedAgentIds.push(ctx.payload.agentId);
        ctx.setResult({ success: true });
      }),
    ];
    service = new MakaioSessionService(MakaioBus, { machineId: MACHINE_ID });
    await service.init();
  });

  afterEach(() => {
    service?.destroy();
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Register the adapter stub a start dispatches into.
   * @param stub - How the adapter answers.
   */
  function registerStartAgent(stub: StartAgentStub = {}): void {
    cleanups.push(
      MakaioBus.on(AdapterSubjects.startAgent, async (ctx) => {
        const agentId = ctx.payload.agentId ?? 'adapter-minted-agent';
        await stub.duringDispatch?.(agentId);
        if (stub.throwWith !== undefined) throw new Error(stub.throwWith);
        if (stub.refuseWith !== undefined) {
          ctx.setResult({ success: false as const, dispatch: stub.refuseWith, message: 'refused by stub' });
          return;
        }
        const adapterSessionId = stub.adapterSessionId === undefined ? 'provider-1' : stub.adapterSessionId;
        ctx.setResult({
          success: true as const,
          agentId,
          adapterId: ctx.payload.adapterId,
          sessionId: ctx.payload.sessionId ?? 'unexpected-session',
          ...(adapterSessionId !== null && { adapterSessionId }),
        });
      }),
    );
  }

  /**
   * Create an empty session.
   * @param sessionId - Session to create.
   * @returns The created session ID.
   */
  async function seedSession(sessionId: string): Promise<string> {
    await MakaioBus.request(SessionSubjects.create, { sessionId });
    return sessionId;
  }

  /**
   * Run one fresh lead start against the composed authority.
   * @param sessionId - Session to start into.
   * @param runtime - Runtime facts to put on the composed start request.
   * @param expectedLeadAgentId - Designation the caller observed; defaults to none.
   * @returns Whatever the start decided.
   */
  function start(sessionId: string, runtime?: LeadStartRuntimeFields, expectedLeadAgentId: string | null = null) {
    return startLeadAgent(MakaioBus, {
      sessionId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      expectedLeadAgentId,
      startRequest: { adapterId: ADAPTER_ID, sessionId, role: 'lead', ...runtime },
    });
  }

  /**
   * Read a stored agent row.
   * @param agentId - Agent to read.
   * @returns The row, or `null` when it is gone.
   */
  async function loadAgent(agentId: string): Promise<MakaioSessionAgent | null> {
    const { agent } = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
    return agent;
  }

  /**
   * Read a stored session row.
   * @param sessionId - Session to read.
   * @returns The row, or `null` when it is gone.
   */
  async function loadSession(sessionId: string): Promise<IMakaioSession | null> {
    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    return session;
  }

  /**
   * List every claim on the test machine.
   * @returns The claims, in storage order.
   */
  async function loadClaims(): Promise<AdapterSessionClaimRecord[]> {
    const { claims } = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
    return claims;
  }

  it('designates the lead in storage before the adapter is dispatched to (case 28)', async () => {
    const sessionId = await seedSession('lead-start-order');
    let leadAtDispatch: string | null | undefined;
    let dispatchedAgentId: string | undefined;
    registerStartAgent({
      duringDispatch: async (agentId) => {
        dispatchedAgentId = agentId;
        leadAtDispatch = (await loadSession(sessionId))?.leadAgentId ?? null;
      },
    });

    const result = await start(sessionId);

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') return;
    // The identity is the caller's, and it was already the session's lead when
    // the adapter first saw it.
    expect(dispatchedAgentId).toBe(result.agent.agentId);
    expect(leadAtDispatch).toBe(result.agent.agentId);
  });

  it('keeps the row `starting` through the adapter return and settles it to `idle` (case 30)', async () => {
    const sessionId = await seedSession('lead-start-status');
    let statusAtDispatch: string | undefined;
    registerStartAgent({
      duringDispatch: async (agentId) => {
        statusAtDispatch = (await loadAgent(agentId))?.status;
      },
    });

    const result = await start(sessionId);

    expect(statusAtDispatch).toBe('starting');
    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') return;
    const stored = await loadAgent(result.agent.agentId);
    expect(stored?.status).toBe('idle');
    expect(stored?.adapterSessionId).toBe('provider-1');
    expect(stored?.currentAdapterSessionId).toBe('provider-1');
    expect(stored?.currentAdapterSessionIdState).toBe('confirmed');
  });

  it('settles a movement announced while the start is still dispatching (case 29)', async () => {
    const sessionId = await seedSession('lead-start-movement');
    registerStartAgent({
      duringDispatch: async (agentId) => {
        await MakaioBus.emit(AgentSubjects.adapterSession.moved, {
          agentId,
          adapterId: ADAPTER_ID,
          adapterName: ADAPTER_NAME,
          sessionId,
          confirmed: true,
          adapterSessionId: 'provider-1',
        });
        await waitForAsync();
      },
    });

    const result = await start(sessionId);

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') return;
    const stored = await loadAgent(result.agent.agentId);
    expect(stored?.currentAdapterSessionId).toBe('provider-1');
    expect(stored?.status).toBe('idle');
    // The start's own settlement recognized the generation the movement took
    // rather than minting a second one for the same key.
    const claims = await loadClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.agentId).toBe(result.agent.agentId);
  });

  it('rolls a `not-dispatched` refusal back to no row and no designation (case 31)', async () => {
    const sessionId = await seedSession('lead-start-refused');
    registerStartAgent({ refuseWith: 'not-dispatched' });

    await expect(start(sessionId)).rejects.toThrow(SessionStartError);

    const session = await loadSession(sessionId);
    expect(session?.agents).toEqual([]);
    // The reservation designated no previous lead, so the compare-and-swap
    // restore is the sanctioned clear.
    expect(session?.leadAgentId ?? null).toBeNull();
    expect(await loadClaims()).toEqual([]);
  });

  it('retires an uncertain dispatch without giving the key back (case 31, uncertain half)', async () => {
    const sessionId = await seedSession('lead-start-uncertain');
    registerStartAgent({ throwWith: 'connector exploded' });

    await expect(start(sessionId)).rejects.toThrow('connector exploded');

    const session = await loadSession(sessionId);
    expect(session?.agents).toHaveLength(1);
    // The row survives as `dead` and keeps the designation: the session's lead
    // still names an agent it legitimately has.
    expect(session?.agents[0]?.status).toBe('dead');
    expect(session?.leadAgentId).toBe(session?.agents[0]?.agentId);
    // And the teardown left no generation blocking a key. A fresh start is
    // keyless, so the fan-out has nothing to file here — asserted rather than
    // assumed, because a start that *did* settle before failing would.
    expect(await loadClaims()).toEqual([]);
  });

  it('resolves two concurrent fresh starts through the designation CAS (case 32)', async () => {
    const sessionId = await seedSession('lead-start-race');
    registerStartAgent();

    const [first, second] = await Promise.all([start(sessionId), start(sessionId)]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['lead-conflict', 'started']);
    const winner = first.outcome === 'started' ? first : second;
    if (winner.outcome !== 'started') return;
    const session = await loadSession(sessionId);
    // The loser left nothing behind: no second agent, and the winner's
    // designation standing.
    expect(session?.agents).toHaveLength(1);
    expect(session?.leadAgentId).toBe(winner.agent.agentId);
  });

  it('claims a crashed start for recovery through the status CAS (case 33)', async () => {
    const sessionId = await seedSession('lead-start-crashed');
    const agentId = 'crashed-agent';
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        sessionId,
        role: 'lead',
        status: 'starting',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    });
    const session = await loadSession(sessionId);
    if (session === null) throw new Error('seeded session is missing');

    const resolution = await resolveInFlightStarts(MakaioBus, session);

    // No entry in this process: the attempt belonged to one that is gone, so
    // this send claims the recovery instead of joining anything.
    expect([...resolution.recoveringAgentIds]).toEqual([agentId]);
    expect((await loadAgent(agentId))?.status).toBe('dead');
    // P1 held no claim, so a crashed reservation leaves no ownership debris.
    expect(await loadClaims()).toEqual([]);
  });

  it('joins an in-flight start instead of rehydrating behind it (case 34)', async () => {
    const sessionId = await seedSession('lead-start-join');
    let releaseDispatch: (() => void) | undefined;
    const dispatchReached = new Promise<void>((resolve) => {
      registerStartAgent({
        duringDispatch: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseDispatch = release;
          });
        },
      });
    });

    const pending = start(sessionId);
    await dispatchReached;
    // The `starting` row is visible, which is exactly the window a concurrent
    // send used to walk into a second lifecycle through.
    const observed = await loadSession(sessionId);
    if (observed === null) throw new Error('seeded session is missing');
    expect(observed.agents[0]?.status).toBe('starting');

    const joining = resolveInFlightStarts(MakaioBus, observed);
    releaseDispatch?.();
    const resolution = await joining;
    const result = await pending;

    expect(result.outcome).toBe('started');
    expect([...resolution.droppedAgentIds]).toEqual([]);
    expect([...resolution.recoveringAgentIds]).toEqual([]);
    expect(rehydratedAgentIds).toEqual([]);
  });

  it.each([
    { label: 'a machine the caller named', machineId: 'remote-machine' },
    { label: "the authority's own", machineId: undefined },
  ])('names $label in both the reservation and the settlement', async ({ machineId }) => {
    // An adapter instance ID is a one-way hash of `(machineId, adapterName)`, so
    // the machine an ownership act names has to be the one its instance came
    // from. A start that reserves and settles under this runtime while
    // dispatching to another machine's instance builds a key nobody else
    // computes — it collides with nothing and protects nothing, and the real
    // machine's runtime reserves the same provider session and wins.
    const sessionId = await seedSession(`lead-start-machine-${machineId ?? 'own'}`);
    const named: Array<string | undefined> = [];
    cleanups.push(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        (ctx) => {
          named.push(ctx.payload.machineId);
          return ctx.next();
        },
        { priority: 1000 },
      ),
      MakaioBus.on(
        SessionSubjects.ownership.settleMovement,
        (ctx) => {
          named.push(ctx.payload.machineId);
          return ctx.next();
        },
        { priority: 1000 },
      ),
    );
    registerStartAgent();

    const result = await startLeadAgent(MakaioBus, {
      sessionId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      expectedLeadAgentId: null,
      ...(machineId !== undefined && { machineId }),
      startRequest: { adapterId: ADAPTER_ID, sessionId, role: 'lead' },
    });

    expect(result.outcome).toBe('started');
    // The reservation is keyless for a fresh start, so the settlement is the one
    // keyed act — and both name the same identity, whichever it is.
    expect(named).toEqual([machineId, machineId]);
  });

  it('does not let a refused origin write pass as a completed start', async () => {
    // The column is write-once, so a dropped write is a start that permanently
    // misreports where its conversation began — and every later native resume
    // reads it. A refusal is one of the two failure forms; the throw is pinned
    // by the case below, and both land in the same region.
    const sessionId = await seedSession('lead-start-origin-refused');
    cleanups.push(
      MakaioBus.on(
        AgentStorageSubjects.updateRuntime,
        (ctx) => {
          ctx.setResult({ success: false });
        },
        { priority: 1000 },
      ),
    );
    registerStartAgent();

    await expect(start(sessionId)).rejects.toMatchObject({ code: 'settlement-unresolved' });

    // The settle ran first, so this failure has a real generation to retire.
    const claims = await loadClaims();
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.status === 'abandoned')).toBe(true);
    expect(stoppedAgentIds).toHaveLength(1);
  });

  it('names a removal as a removal when the completion fails on it', async () => {
    // A post-dispatch step fails *because* the row is gone: the write that names
    // it is refused like any other refusal, so without a re-read the removal is
    // reported as "the settlement did not resolve" — which is the code a
    // consumer branches on, and the rehydrate path has always classified it
    // correctly. One table for every caller-owned teardown, or the three paths
    // answer one fact three ways.
    const sessionId = await seedSession('lead-start-removed-under-completion');
    cleanups.push(
      MakaioBus.on(
        AgentStorageSubjects.updateRuntime,
        async (ctx) => {
          await MakaioBus.request(AgentStorageSubjects.delete, { agentId: ctx.payload.agentId });
          return ctx.next();
        },
        { priority: 1000 },
      ),
    );
    registerStartAgent();

    await expect(start(sessionId)).rejects.toMatchObject({ code: 'agent-unavailable' });

    // Classified differently, torn down the same way: the connector nobody
    // proved closed is stopped. Nothing is left to retire — deleting the row
    // cascades its claims away, which is the removal's own doing and the reason
    // this failure has a name other than an unresolved settlement.
    expect(stoppedAgentIds).toHaveLength(1);
    expect(await loadClaims()).toHaveLength(0);
    expect(await loadAgent(stoppedAgentIds[0] ?? '')).toBeNull();
  });

  it('claims the confirmed key before the bookkeeping that can fail on it', async () => {
    // The runtime write records where the conversation *began*; the settlement
    // claims the key the connector is speaking to *now*. Run first, the record
    // could fail and take the claim with it — leaving the confirmed provider
    // session unclaimed under a connector nobody proved closed, and no
    // generation for the failure path to give back.
    const sessionId = await seedSession('lead-start-origin-after-settle');
    cleanups.push(
      MakaioBus.on(
        AgentStorageSubjects.updateRuntime,
        () => {
          throw new Error('runtime write transport failed');
        },
        { priority: 1000 },
      ),
    );
    registerStartAgent();

    await expect(start(sessionId)).rejects.toMatchObject({ code: 'settlement-unresolved' });

    // The key was claimed before the write that failed, so the failure has a
    // real generation to retire — `abandoned`, which keeps the key blocked for a
    // provider session nobody has proven closed, rather than free for a second
    // driver.
    const claims = await loadClaims();
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.status === 'abandoned')).toBe(true);
    expect(stoppedAgentIds).toHaveLength(1);
  });

  it('leaves a post-dispatch failure recoverable by the next default send (case 31, follow-on)', async () => {
    // Why case 31 keeps the designation rather than clearing it, asserted rather
    // than argued. A fresh start has no previous lead to restore, so clearing is
    // the whole effect — and a session holding the `dead` row the failure kept
    // (I15) with nothing designated is one `resolveTargetAgents` raises for.
    // Kept, the lead names an agent the session has, and the next send's own
    // consumer rule recovers it.
    const sessionId = await seedSession('lead-start-recoverable-after-failure');
    registerStartAgent({ throwWith: 'provider start exploded' });

    await expect(start(sessionId)).rejects.toThrow('provider start exploded');

    const session = await loadSession(sessionId);
    if (session === null) throw new Error('seeded session is missing');
    expect(session.leadAgentId).toBe(session.agents[0]?.agentId);
    // The default target still resolves, and resolves to the dead row — which is
    // exactly what the send path's recovery step is for.
    expect(resolveTargetAgents(session, undefined).map((agent) => agent.status)).toEqual(['dead']);
    const resolution = await resolveInFlightStarts(MakaioBus, session);
    expect([...resolution.droppedAgentIds]).toEqual([]);
  });

  it('keeps a healthy start whose row a peer stomped to dead (cases 35, 98a)', async () => {
    const sessionId = await seedSession('lead-start-peer-dead');
    registerStartAgent({
      duringDispatch: async (agentId) => {
        // A peer applying the in-flight consumer rule compare-and-swaps
        // `starting → dead` to claim this recovery. Under Wave 3 it then
        // reserves, is told `occupied` and degrades — it never touches the
        // provider session. The status write says nothing about ownership, and
        // reading it as a lost start would stop a live connector (I21′).
        await MakaioBus.request(AgentStorageSubjects.updateStatus, {
          agentId,
          status: 'dead',
          expectedStatus: ['starting'],
        });
      },
    });

    const result = await start(sessionId);

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') return;
    // `dead` is in the commit's expectation precisely so the owner restores it.
    expect((await loadAgent(result.agent.agentId))?.status).toBe('idle');
    expect(stoppedAgentIds).toEqual([]);
  });

  it('accepts a peer that wrote idle first as a silent no-op (case 98b)', async () => {
    const sessionId = await seedSession('lead-start-peer-idle');
    registerStartAgent({
      duringDispatch: async (agentId) => {
        // What an *unreserved* attempt joining the same agent writes.
        await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
      },
    });

    const result = await start(sessionId);

    expect(result.outcome).toBe('started');
    expect(stoppedAgentIds).toEqual([]);
  });

  it.each([
    { label: 'disposed', dispose: true },
    { label: 'deleted', dispose: false },
  ])('reports a start whose row was $label under it as unavailable (case 98c, Path A)', async ({ dispose }) => {
    const sessionId = await seedSession(`lead-start-removed-${dispose ? 'disposed' : 'deleted'}`);
    registerStartAgent({
      duringDispatch: async (agentId) => {
        // A removal landing between the dispatch and the commit. It is terminal
        // and owner-independent, so reading it cannot be raced — and it is the
        // one refusal that means this attempt's connector has no generation.
        if (dispose) {
          await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });
          return;
        }
        await MakaioBus.request(AgentStorageSubjects.delete, { agentId });
      },
    });

    const failure = await start(sessionId).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionStartError);
    if (!(failure instanceof SessionStartError)) return;
    expect(failure.code).toBe('agent-unavailable');
    expect(stoppedAgentIds).toHaveLength(1);
    const claims = await loadClaims();
    expect(claims.every((claim) => claim.status !== 'held')).toBe(true);
  });

  it('applies the join-result table to a start that deleted its row (case 36)', async () => {
    const sessionId = await seedSession('lead-start-join-deleted');
    const agentId = 'joined-agent';
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        sessionId,
        role: 'lead',
        status: 'starting',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    });
    const session = await loadSession(sessionId);
    if (session === null) throw new Error('seeded session is missing');

    let releaseAttempt: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => {
      void runExclusiveStart(agentId, async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseAttempt = release;
        });
        await MakaioBus.request(AgentStorageSubjects.delete, { agentId });
        // A pre-dispatch failure both deletes the row and rejects the attempt.
        // The verdict never arrives, which is the point: the row is what the
        // resolution reads.
        throw new Error('pre-dispatch failure');
      }).settled.catch(() => undefined);
    });
    await attemptStarted;

    const joining = resolveInFlightStarts(MakaioBus, session);
    releaseAttempt?.();
    const resolution = await joining;

    // The row the cleanup left behind is authoritative — never the rejection.
    expect([...resolution.droppedAgentIds]).toEqual([agentId]);
    expect(session.agents).toEqual([]);
  });

  it.each([
    { status: 'disposed' as const, dropped: true },
    { status: 'dead' as const, dropped: false },
  ])('applies the join-result table to a $status row (case 36)', async ({ status, dropped }) => {
    const sessionId = await seedSession(`lead-start-join-${status}`);
    const agentId = `joined-${status}-agent`;
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        sessionId,
        role: 'lead',
        status: 'starting',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    });
    const session = await loadSession(sessionId);
    if (session === null) throw new Error('seeded session is missing');

    let releaseAttempt: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => {
      void runExclusiveStart(agentId, async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseAttempt = release;
        });
        await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status });
        // Immaterial here: this resolution is about the identity's state, which
        // only the row can answer.
        return 'connected';
      }).settled;
    });
    await attemptStarted;

    const joining = resolveInFlightStarts(MakaioBus, session);
    releaseAttempt?.();
    const resolution = await joining;

    expect([...resolution.droppedAgentIds]).toEqual(dropped ? [agentId] : []);
    expect([...resolution.recoveringAgentIds]).toEqual(dropped ? [] : [agentId]);
  });

  it('fails the send when a row stays `starting` past the bounded re-read (case 36)', async () => {
    const sessionId = await seedSession('lead-start-unresolved');
    const agentId = 'stuck-agent';
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        sessionId,
        role: 'lead',
        status: 'starting',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    });
    // A peer that keeps winning the arbitration: the compare-and-swap is refused
    // every time while the row genuinely stays `starting`.
    cleanups.push(
      MakaioBus.on(
        AgentStorageSubjects.updateStatus,
        (ctx) => {
          ctx.setResult({ success: true, transitioned: false });
        },
        { priority: 100 },
      ),
    );
    const session = await loadSession(sessionId);
    if (session === null) throw new Error('seeded session is missing');

    const failure = await resolveInFlightStarts(MakaioBus, session).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionStartError);
    if (!(failure instanceof SessionStartError)) return;
    expect(failure.code).toBe('start-unresolved');
  });

  it('stops the connector when the settlement is refused on ownership grounds (case 37)', async () => {
    // A live incumbent on another session holds the key the start will report.
    const incumbentSession = await seedSession('lead-start-incumbent');
    const incumbentId = 'incumbent-agent';
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: incumbentId,
      agent: {
        agentId: incumbentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        sessionId: incumbentSession,
        role: 'lead',
        status: 'idle',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    });
    const reserved = await MakaioBus.request(SessionSubjects.ownership.reserveStart, {
      sessionId: incumbentSession,
      agentId: incumbentId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      role: 'member',
      resumeProviderSessionId: 'provider-1',
    });
    expect(reserved.outcome).toBe('reserved');

    const sessionId = await seedSession('lead-start-refused-settle');
    registerStartAgent({ adapterSessionId: 'provider-1' });

    const failure = await start(sessionId).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionStartError);
    if (!(failure instanceof SessionStartError)) return;
    expect(failure.code).toBe('ownership-refused');
    expect(stoppedAgentIds).toHaveLength(1);
    const session = await loadSession(sessionId);
    // Never `idle`: the transition is permitted only after an accepted settlement.
    expect(session?.agents[0]?.status).toBe('dead');
    const claims = await loadClaims();
    expect(claims.map((claim) => [claim.agentId, claim.status])).toEqual([[incumbentId, 'held']]);
  });

  it('deletes the row when the write that stored it throws after committing', async () => {
    // The same acquisition frame the attach path needed. This write is a round
    // trip like any other: its transaction can commit while its response is
    // lost, and a rollback region that began after it would leave a `starting`
    // row with no reservation, no owner and no connector — a phantom every later
    // send has to arbitrate over.
    const sessionId = await seedSession('lead-start-lost-row-write');
    let rowDeletes = 0;
    cleanups.push(
      MakaioBus.on(
        AgentStorageSubjects.delete,
        (ctx) => {
          rowDeletes += 1;
          return ctx.next();
        },
        { priority: 100 },
      ),
      MakaioBus.on(
        AgentStorageSubjects.set,
        (ctx) => {
          // Committed, then lost: written through to the store, reported failed.
          ctx.next();
          throw new Error('agent storage response was lost');
        },
        { priority: 100 },
      ),
    );
    registerStartAgent({ adapterSessionId: 'provider-lost-write' });

    const failure = await start(sessionId).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    // Nothing was dispatched, and the row the write may have stored is gone.
    expect(rowDeletes).toBe(1);
    const session = await loadSession(sessionId);
    expect(session?.agents ?? []).toEqual([]);
  });

  it('keeps the refusal it classified when the terminal status write throws', async () => {
    // The teardown a refused settlement performs is best-effort down to its last
    // step: the generations are already back, and the status it writes is not
    // ownership evidence — a row left `starting` is resolved by the send path's
    // in-flight rule, which is what the `settlement-unresolved` outcome relies
    // on by design. So a storage failure in that write must not replace the
    // refusal the authority named with an error about the cleanup.
    const incumbentSession = await seedSession('lead-start-incumbent-throwing');
    const incumbentId = 'incumbent-agent-throwing';
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: incumbentId,
      agent: {
        agentId: incumbentId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        sessionId: incumbentSession,
        role: 'lead',
        status: 'idle',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    });
    const reserved = await MakaioBus.request(SessionSubjects.ownership.reserveStart, {
      sessionId: incumbentSession,
      agentId: incumbentId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      role: 'member',
      resumeProviderSessionId: 'provider-throwing',
    });
    expect(reserved.outcome).toBe('reserved');

    // Only the terminal write fails; every other transition this start makes is
    // left alone, so the case fails for the reason it is about.
    cleanups.push(
      MakaioBus.on(
        AgentStorageSubjects.updateStatus,
        (ctx) => {
          if (ctx.payload.status === 'dead') throw new Error('agent storage is unavailable');
          ctx.next();
        },
        { priority: 100 },
      ),
    );

    const sessionId = await seedSession('lead-start-refused-settle-throwing');
    registerStartAgent({ adapterSessionId: 'provider-throwing' });

    const failure = await start(sessionId).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionStartError);
    if (!(failure instanceof SessionStartError)) return;
    expect(failure.code).toBe('ownership-refused');
    // And the teardown ran once, not twice: the connector was stopped exactly
    // once and the incumbent's generation is untouched.
    expect(stoppedAgentIds).toHaveLength(1);
    const claims = await loadClaims();
    expect(claims.map((claim) => [claim.agentId, claim.status])).toEqual([[incumbentId, 'held']]);
  });

  it('refuses every later ownership act for an agent removed mid-start (case 38)', async () => {
    const sessionId = await seedSession('lead-start-removed');
    let removedAgentId: string | undefined;
    registerStartAgent({
      duringDispatch: async (agentId) => {
        removedAgentId = agentId;
        await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });
      },
    });

    const failure = await start(sessionId).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionStartError);
    if (!(failure instanceof SessionStartError) || removedAgentId === undefined) return;
    expect(failure.code).toBe('agent-unavailable');
    expect(stoppedAgentIds).toEqual([removedAgentId]);
    // The `idle` transition never ran, and ownership stays absorbing.
    expect((await loadAgent(removedAgentId))?.status).toBe('disposed');
    const retry = await MakaioBus.request(SessionSubjects.ownership.reserveStart, {
      sessionId,
      agentId: removedAgentId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      role: 'member',
      resumeProviderSessionId: 'provider-1',
    });
    expect(retry.outcome).toBe('agent-disposed');
  });
  it('carries the start request’s runtime facts onto the caller-owned row', async () => {
    // Supplying `agentId` transfers the row to the caller, and the adapter then
    // performs no whole-record write of its own — so this row is the only one
    // there is. Anything the adapter's suppressed write used to persist has to
    // be persisted here, or it never reaches storage at all and every reader of
    // `session.agents` sees an agent with no model and no working directory.
    const sessionId = await seedSession('lead-start-runtime-fields');
    registerStartAgent({ adapterSessionId: 'provider-runtime-fields' });

    const result = await start(sessionId, {
      model: 'sonnet',
      cwd: '/repo/worktree',
      allowedDirectories: ['/repo/worktree', '/tmp'],
      clientId: 'client-under-test',
      harnessId: 'harness-under-test',
    });

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') return;
    const stored = await loadAgent(result.agent.agentId);
    expect(stored).toMatchObject({
      model: 'sonnet',
      cwd: '/repo/worktree',
      allowedDirectories: ['/repo/worktree', '/tmp'],
      clientId: 'client-under-test',
      harnessId: 'harness-under-test',
      // The origin identity still arrives after the dispatch reports one.
      adapterSessionId: 'provider-runtime-fields',
      status: 'idle',
    });
  });
  it('reserves against the designation the caller observed, not against none', async () => {
    // A session reaches the fresh-start branch when it has no *agents*, which is
    // not the same as having no *designation*: the in-flight resolution drops a
    // deleted or disposed agent from the target set and deliberately leaves the
    // lead it may have been standing. Claiming "I observed no lead" would then
    // lose a compare-and-swap against a name nothing can clear, and that session
    // could never start a lead again.
    const sessionId = await seedSession('lead-start-stale-designation');
    const departed = 'agent-departed';
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: departed,
      agent: {
        agentId: departed,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        sessionId,
        role: 'lead',
        status: 'idle',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    });
    // Designated through the one writer, then deleted without a clear — the
    // shape a removal leaves when the row is already gone.
    await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
      machineId: MACHINE_ID,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      providerSessionId: null,
      sessionId,
      agentId: departed,
      claimToken: crypto.randomUUID(),
      designateLead: { expectedLeadAgentId: null },
    });
    await MakaioBus.request(AgentStorageSubjects.delete, { agentId: departed });
    expect((await loadSession(sessionId))?.leadAgentId).toBe(departed);

    registerStartAgent();
    const result = await start(sessionId, undefined, departed);

    expect(result.outcome).toBe('started');
    if (result.outcome !== 'started') return;
    const session = await loadSession(sessionId);
    expect(session?.leadAgentId).toBe(result.agent.agentId);
  });

  it('takes the agent row back when the reservation itself fails', async () => {
    // A reservation that throws is a pre-dispatch failure like any other, and
    // the row written a moment earlier is the only thing to take back. Leaving
    // it would strand a `starting` agent that every later send has to arbitrate
    // over — on a host whose ownership storage is missing, forever.
    const sessionId = await seedSession('lead-start-reservation-throws');
    registerStartAgent();
    const broken = MakaioBus.on(
      SessionSubjects.ownership.reserveStart,
      () => {
        throw new Error('ownership storage is not registered');
      },
      { priority: 100 },
    );
    try {
      await expect(start(sessionId)).rejects.toThrow('ownership storage is not registered');
    } finally {
      broken();
    }

    // Nothing dispatched, nothing left behind — not the row, and not a
    // designation pointing at it.
    const session = await loadSession(sessionId);
    expect(session?.agents).toEqual([]);
    expect(session?.leadAgentId).toBeUndefined();
  });
  it('arbitrates the winner’s still-starting agent when a send loses the designation race', async () => {
    // §15 Step-7's known gap, and the hazard hiding in it. The winner designates
    // *before* it dispatches, so the agent a losing send adopts on its re-read is
    // very likely still `starting` — and it has never been through the consumer
    // rule, because that ran while the session still had no agents. Left
    // unresolved, the liveness probe finds no connector, reads that as dead, and
    // opens a second lifecycle against a start that is still running. The winner
    // here belongs to another process, so this runtime's registry cannot see it
    // and only the status compare-and-swap can arbitrate.
    const sessionId = await seedSession('lead-start-adopted-starting');
    const winner = 'winner-agent';

    // The winner lands *between* this send's session read and its reservation,
    // which is what makes the reservation lose: it names the lead it read (none)
    // and the row now names somebody else.
    let winnerLanded = false;
    cleanups.push(
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        async (ctx) => {
          if (!winnerLanded) {
            winnerLanded = true;
            await MakaioBus.request(AgentStorageSubjects.set, {
              agentId: winner,
              agent: {
                agentId: winner,
                adapterId: ADAPTER_ID,
                adapterName: ADAPTER_NAME,
                sessionId,
                role: 'lead',
                // Reserved and published; its dispatch is still in flight.
                status: 'starting',
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
              },
            });
            await MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
              machineId: MACHINE_ID,
              adapterId: ADAPTER_ID,
              adapterName: ADAPTER_NAME,
              providerSessionId: null,
              sessionId,
              agentId: winner,
              claimToken: crypto.randomUUID(),
              designateLead: { expectedLeadAgentId: null },
            });
          }
          await ctx.next();
        },
        { priority: 100 },
      ),
    );

    const orchestrator = new SessionOrchestrator(MakaioBus, MACHINE_ID);
    cleanups.push(() => {
      orchestrator.destroy();
    });
    registerStartAgent();
    const routed: string[] = [];
    cleanups.push(
      MakaioBus.on(AgentSubjects.sendMessage, (ctx) => {
        routed.push(ctx.payload.agentId);
        ctx.setResult({ messageId: ctx.payload.messageId ?? crypto.randomUUID() });
      }),
    );

    await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'adopts the winner',
      agent: { kind: 'adapter', adapterName: ADAPTER_NAME },
    });

    // The adopted agent went through the arbitration instead of past it: its row
    // left `starting` by compare-and-swap, and the send recovered it rather than
    // dispatching a bare probe-driven rehydrate beside a live start.
    const stored = await loadAgent(winner);
    expect(stored?.status).not.toBe('starting');
    expect(rehydratedAgentIds).toEqual([winner]);
    // No second lead was started beside the winner, and the send routed to it.
    const session = await loadSession(sessionId);
    expect(session?.agents.map((agent) => agent.agentId)).toEqual([winner]);
    expect(session?.leadAgentId).toBe(winner);
    expect(routed).toEqual([winner]);
  });
});
