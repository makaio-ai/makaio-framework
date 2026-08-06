/**
 * Cases 204, 204b, 204c, 204d and 204e — the single teardown flight.
 *
 * Driven against the real registry, the real arbiter and the **real memory agent
 * storage**, because the whole of "one *effective* terminal status" rests on
 * `disposed` being terminal inside `storage:agent.updateStatus`. A recorder that
 * answered `{ success: true }` to every write would make the case pass without the
 * property it exists to prove.
 *
 * The two suites after 204d carry the same seam's structural guarantees: that a
 * settlement removes only its **own** replacement entry on a re-claimed identity,
 * and that a flight is installed before any close begins rather than a microtask
 * after it — both properties the flight was relying on another subsystem's
 * scheduling for.
 */
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { ConnectorTeardownResult, MakaioSessionAgent, TeardownEvidence } from '@makaio/contracts';
import {
  AgentStorageSubjects,
  createSessionStorageMemoryState,
  registerMemoryAgentStorage,
  type SessionStorageMemoryState,
} from '@makaio/services-core/session';
import { DeferredPromise } from '@makaio/utils';
import { AgentTeardownArbiter } from '../../agent/agent-teardown-arbiter.js';
import { createTestableAgent, MockConnector, type TestableAgent } from '../../agent/__tests__/helpers/mock-agent.js';
import { ActiveAgentRegistry, type AgentDisposalReport } from '../agent-registry.js';

/**
 * A connector whose close can re-enter the registry **synchronously**.
 *
 * The reentrancy this models is `agent.session.closed`, whose handler evicts — but
 * that emission is fire-and-forget, so an arm driven through it cannot tell a flight
 * installed before the close from one installed a microtask later. `AIAgent.close`
 * reaches `connector.close()` in the same synchronous step it was itself called in,
 * which makes this the one place a test can arrive inside the window the
 * install-before-any-close rule is about.
 */
class ReentrantCloseConnector extends MockConnector {
  /** Run once, synchronously, on entering this generation's close. */
  public onCloseEntered: (() => void) | undefined;

  /**
   * Re-enter the registry, then run the close the test configured.
   * @returns The configured teardown result
   */
  public override async close(): Promise<ConnectorTeardownResult> {
    const reenter = this.onCloseEntered;
    // One-shot: a reentrant teardown that reached a second close must not recurse.
    this.onCloseEntered = undefined;
    reenter?.();
    return super.close();
  }
}

const AGENT_ID = 'agent-flight';
const SESSION_ID = 'session-flight';

let state: SessionStorageMemoryState;
let arbiter: AgentTeardownArbiter;
let registry: ActiveAgentRegistry;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  state = createSessionStorageMemoryState();
  cleanups.push(registerMemoryAgentStorage(MakaioBus, state));
  arbiter = new AgentTeardownArbiter();
  registry = new ActiveAgentRegistry({ globalBus: MakaioBus, adapterName: 'flight-adapter', arbiter });
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
});

/**
 * Seed a real stored agent row so the terminal-status law is the real one.
 * @param status - Status the row starts in
 */
async function seedAgentRow(status: MakaioSessionAgent['status'] = 'idle'): Promise<void> {
  await MakaioBus.request(AgentStorageSubjects.set, {
    agentId: AGENT_ID,
    agent: {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      adapterId: 'adapter-1',
      adapterName: 'flight-adapter',
      role: 'lead',
      model: 'test-model',
      cwd: '/test/cwd',
      status,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    },
  });
}

/** The stored row's current status, read back through the real handler. */
async function storedStatus(): Promise<MakaioSessionAgent['status'] | undefined> {
  const result = await MakaioBus.request(AgentStorageSubjects.get, { agentId: AGENT_ID });
  return result.agent?.status;
}

/**
 * Drain the microtask queue.
 *
 * Enough to carry a connector replacement from the swap call to the `initialize()`
 * it is parked in, and from a released `initialize()` through its own settlement —
 * promise work throughout, touching no timer.
 */
async function flushMicrotasks(): Promise<void> {
  for (let hop = 0; hop < 32; hop += 1) await Promise.resolve();
}

/**
 * Register one live agent whose close the test can hold open.
 * @param options - Gate applied to a replacement generation, when the test makes one
 * @returns The agent and the incumbent connector generation it holds
 */
async function registerLiveAgent(
  options: { replacementInitializeGate?: Promise<void>; replacementCloseGate?: Promise<void> } = {},
): Promise<{ agent: TestableAgent; connector: ReentrantCloseConnector; replacements: ReentrantCloseConnector[] }> {
  const built: ReentrantCloseConnector[] = [];
  const agent = createTestableAgent({
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    teardownArbiter: arbiter,
    // A real directory, because a replacement swaps into one.
    initialCwd: os.tmpdir(),
    mockConnectorFactory: (config) => {
      const connector = new ReentrantCloseConnector(config.model, config.cwd);
      // Only a replacement is ever parked: the incumbent has to finish initializing
      // for the agent to exist at all.
      if (built.length > 0) {
        connector.initializeGate = options.replacementInitializeGate;
        connector.closeGate = options.replacementCloseGate;
      }
      built.push(connector);
      return connector;
    },
  });
  await agent.init();
  const connector = built[0];
  if (connector === undefined) throw new Error('the agent built no connector generation');
  registry.set(AGENT_ID, {
    agent,
    sessionId: SESSION_ID,
    adapterSessionId: 'provider-session-1',
    usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
  });
  return { agent, connector, replacements: built };
}

/**
 * Drive one agent into the state an abandoned settlement wait leaves behind.
 *
 * No entry, no teardown flight, and a connector replacement that still holds both
 * runtimes and closes neither until it settles. The wait is abandoned with a
 * **deadline already inside the observation margin** rather than by advancing a
 * clock: the clamp yields a zero wait there, which is the expiry arm reached without
 * this suite needing controlled time.
 * @param options - Optional close gate for the replacement generation
 * @returns The held replacement's release, and the swap itself to await
 */
async function abandonReplacementInFlight(
  options: { replacementCloseGate?: Promise<void> } = {},
): Promise<{ release: () => void; replacement: ReentrantCloseConnector; swap: Promise<unknown> }> {
  const initGate = new DeferredPromise<void>();
  const { agent, replacements } = await registerLiveAgent({
    replacementInitializeGate: initGate.getPromise(),
    replacementCloseGate: options.replacementCloseGate,
  });

  const swap = agent.swapConnector({ cwd: os.tmpdir() }).catch(() => undefined);
  await flushMicrotasks();
  if (!arbiter.hasReplacementInFlight(AGENT_ID)) throw new Error('the swap installed no replacement');

  const abandoned = await registry.evictSilently(AGENT_ID, { deadline: Date.now() });
  if (abandoned.evidence !== 'unknown') throw new Error(`the wait was not abandoned: ${abandoned.evidence}`);
  const replacement = replacements[1];
  if (replacement === undefined) throw new Error('the swap built no replacement connector');
  return { release: () => initGate.resolve(), replacement, swap };
}

describe('case 204: `dispose` awaits what `evict` always awaited, and `evict` still throws', () => {
  it('resolves `dispose` only after the close settled, and writes the terminal `disposed`', async () => {
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    const closeGate = new DeferredPromise<void>();
    connector.closeGate = closeGate.getPromise();
    connector.closeOutcome = { evidence: 'exited' };

    let settled = false;
    const disposal = registry.dispose(AGENT_ID).then((report) => {
      settled = true;
      return report;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    closeGate.resolve();
    const report = await disposal;

    expect(report).toMatchObject({ found: true, evidence: 'exited' });
    expect(connector.closeCount).toBe(1);
    expect(await storedStatus()).toBe('disposed');
  });

  it('writes `disposed` even when the class is weak', async () => {
    // I25: the status records that this adapter gave the agent up, never that a
    // provider conversation ended. A weak class must not suppress it.
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    connector.closeOutcome = { evidence: 'detached', detail: 'supervisor outlives us' };

    const report = await registry.dispose(AGENT_ID);

    expect(report.evidence).toBe('detached');
    expect(await storedStatus()).toBe('disposed');
  });

  it('writes `dead` and then still rethrows the close failure from `evict`', async () => {
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    const closeError = new Error('close exploded');
    connector.closeOutcome = closeError;

    await expect(registry.evict(AGENT_ID)).rejects.toBe(closeError);

    // The rethrow is what the failed-start rollback builds its aggregate from, and
    // the status write happens despite it.
    expect(await storedStatus()).toBe('dead');
    expect(registry.get(AGENT_ID)).toBeUndefined();
  });

  it('returns the class from `evict` when the close did not fail', async () => {
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    connector.closeOutcome = { evidence: 'closed' };

    await expect(registry.evict(AGENT_ID)).resolves.toMatchObject({ evidence: 'closed' });
    expect(await storedStatus()).toBe('dead');
  });
});

describe('case 204b: single-flight teardown joins, it does not restart', () => {
  it('produces one connector close and one effective terminal status for two concurrent stops', async () => {
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    const closeGate = new DeferredPromise<void>();
    connector.closeGate = closeGate.getPromise();
    connector.closeOutcome = { evidence: 'exited' };

    const first = registry.dispose(AGENT_ID);
    // The close is blocked, so the second call provably arrives mid-teardown.
    await Promise.resolve();
    expect(connector.closeCount).toBe(1);
    const second = registry.dispose(AGENT_ID);

    closeGate.resolve();
    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(connector.closeCount).toBe(1);
    // Both callers receive the *same* evidence, because the second read the answer
    // the first was already producing.
    expect(firstReport).toEqual(secondReport);
    expect(firstReport.evidence).toBe('exited');
    expect(await storedStatus()).toBe('disposed');
  });

  it('leaves `disposed` effective whichever wrapper wrote last', async () => {
    // Clause (c): concurrent wrappers may both write, and that is safe *because*
    // `disposed` is terminal in storage — not because anything arbitrates them.
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    const closeGate = new DeferredPromise<void>();
    connector.closeGate = closeGate.getPromise();

    const disposal = registry.dispose(AGENT_ID);
    await Promise.resolve();
    const eviction = registry.evict(AGENT_ID);

    closeGate.resolve();
    await Promise.all([disposal, eviction]);

    expect(connector.closeCount).toBe(1);
    expect(await storedStatus()).toBe('disposed');
  });
});

describe('case 204d: "nothing here" is only answerable when nothing is in flight', () => {
  it('answers `released` with no entry and no teardown in flight', async () => {
    await expect(registry.dispose('never-existed')).resolves.toEqual({ found: false, evidence: 'released' });
  });

  it('joins an in-flight teardown and reports its real evidence, never `released`', async () => {
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    const closeGate = new DeferredPromise<void>();
    connector.closeGate = closeGate.getPromise();
    connector.closeOutcome = { evidence: 'detached', detail: 'child was not ours' };

    const first = registry.evict(AGENT_ID);
    await Promise.resolve();
    // The entry is already gone from this angle only after the close settles, but
    // the flight is what makes the answer real either way.
    const joined = registry.dispose(AGENT_ID);

    closeGate.resolve();
    const [, joinedReport] = await Promise.all([first, joined]);

    expect(joinedReport.found).toBe(true);
    expect(joinedReport.evidence).toBe('detached');
    expect(joinedReport.evidence).not.toBe('released');
  });

  it('answers `unknown` for an identity a start claimed and has not registered', async () => {
    expect(registry.claimAgentIdentity(AGENT_ID)).toBe(true);

    const report = await registry.dispose(AGENT_ID);

    expect(report.found).toBe(false);
    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain(AGENT_ID);
    // Revert probe for the composite: the claim alone must produce this, with no
    // entry and no flight anywhere.
    expect(registry.get(AGENT_ID)).toBeUndefined();
    expect(arbiter.hasTeardownInFlight(AGENT_ID)).toBe(false);
  });

  it('answers `unknown` while a replacement an abandoned wait handed both runtimes to is still running', async () => {
    const held = await abandonReplacementInFlight();
    // Both closeable subjects are gone: the entry with the flight's own `finally`,
    // the flight with the arbiter's. What is left is a replacement holding two live
    // connectors — the state that made the closed list of absences wrong.
    expect(registry.get(AGENT_ID)).toBeUndefined();
    expect(arbiter.hasTeardownInFlight(AGENT_ID)).toBe(false);
    expect(arbiter.hasReplacementInFlight(AGENT_ID)).toBe(true);

    const report = await registry.dispose(AGENT_ID);

    // `released` is the one answer that frees an identity, and it would be a lie
    // while the replacement can still publish and speak.
    expect(report).toMatchObject({ found: false, evidence: 'unknown' });
    expect(report.detail).toContain(AGENT_ID);

    // And the term is not sticky: once the replacement settles, nothing on this
    // instance can be speaking and `released` becomes true again.
    held.release();
    await held.swap;
    await flushMicrotasks();
    await expect(registry.dispose(AGENT_ID)).resolves.toEqual({ found: false, evidence: 'released' });
  });

  it('keeps an abandoned replacement visible until its inherited close retires', async () => {
    const closeGate = new DeferredPromise<void>();
    const held = await abandonReplacementInFlight({ replacementCloseGate: closeGate.getPromise() });

    held.release();
    await flushMicrotasks();
    expect(held.replacement.closeCount).toBe(1);

    // Settlement removed this replacement from current-runtime handover, but its
    // inherited close still owns a live runtime. A no-entry disposal cannot free
    // the identity until that post-settlement obligation retires.
    await expect(registry.dispose(AGENT_ID)).resolves.toMatchObject({ found: false, evidence: 'unknown' });

    closeGate.resolve();
    await held.swap;
    await expect(registry.dispose(AGENT_ID)).resolves.toEqual({ found: false, evidence: 'released' });
  });
});

describe('replacements separate current-runtime handover from identity visibility', () => {
  it('keeps an unsettled predecessor visible through a no-entry disposal until it settles', async () => {
    const held = await abandonReplacementInFlight();

    // A successor reclaims the identity and begins its own replacement. It is the
    // current handover candidate, while the abandoned predecessor still counts as
    // live identity work until its own settlement.
    const second = arbiter.admitSwap(AGENT_ID, () => true);
    const handover = second.settle({ outcome: 'committed', unclosed: [], closeReports: [] });
    expect(second.settle({ outcome: 'rolled-back', unclosed: [], closeReports: [] })).toEqual(handover);
    second.retire();
    second.retire();

    // The successor settled first, leaving no current handover entry. The older
    // replacement remains visible solely through the identity-wide count.
    expect(arbiter.hasReplacementInFlight(AGENT_ID)).toBe(true);
    await expect(registry.dispose(AGENT_ID)).resolves.toMatchObject({ found: false, evidence: 'unknown' });

    held.release();
    await held.swap;
    await flushMicrotasks();
    expect(arbiter.hasReplacementInFlight(AGENT_ID)).toBe(false);
    await expect(registry.dispose(AGENT_ID)).resolves.toEqual({ found: false, evidence: 'released' });
  });

  it('closes a live successor runtime after its own replacement settles first', async () => {
    const predecessor = arbiter.admitSwap(AGENT_ID, () => true);
    const successor = arbiter.admitSwap(AGENT_ID, () => true);
    const closeCurrent = vi.fn(async () => ({ evidence: 'closed' as const }));

    const teardown = arbiter.runTeardown(AGENT_ID, {
      closeCurrent,
      closeUnclosed: async () => ({ evidence: 'closed' }),
      releaseIdentity: () => undefined,
    });
    successor.settle({ outcome: 'committed', unclosed: [], closeReports: [] });
    successor.retire();

    await expect(teardown).resolves.toMatchObject({ evidence: 'closed' });
    expect(closeCurrent).toHaveBeenCalledOnce();
    expect(arbiter.hasReplacementInFlight(AGENT_ID)).toBe(true);

    predecessor.settle({ outcome: 'committed', unclosed: [], closeReports: [] });
    predecessor.retire();
  });

  it('unblocks a successor teardown only when the successor settles', async () => {
    const predecessor = arbiter.admitSwap(AGENT_ID, () => true);
    const successor = arbiter.admitSwap(AGENT_ID, () => true);
    const closeCurrent = vi.fn(async () => ({ evidence: 'closed' as const }));
    let completed = false;
    const teardown = arbiter
      .runTeardown(AGENT_ID, {
        closeCurrent,
        closeUnclosed: async () => ({ evidence: 'closed' }),
        releaseIdentity: () => undefined,
      })
      .then((report) => {
        completed = true;
        return report;
      });

    predecessor.settle({ outcome: 'committed', unclosed: [], closeReports: [] });
    predecessor.retire();
    await flushMicrotasks();
    expect(completed).toBe(false);

    successor.settle({ outcome: 'committed', unclosed: [], closeReports: [] });
    successor.retire();
    await expect(teardown).resolves.toMatchObject({ evidence: 'closed' });
    expect(closeCurrent).toHaveBeenCalledOnce();
  });

  it.each([
    ['predecessor first', 0, 1],
    ['successor first', 1, 0],
  ])('removes identity visibility only after the final retirement (%s)', (_order, first, second) => {
    const admissions = [arbiter.admitSwap(AGENT_ID, () => true), arbiter.admitSwap(AGENT_ID, () => true)];

    admissions[first]?.settle({ outcome: 'committed', unclosed: [], closeReports: [] });
    admissions[first]?.retire();
    expect(arbiter.hasReplacementInFlight(AGENT_ID)).toBe(true);

    admissions[second]?.settle({ outcome: 'committed', unclosed: [], closeReports: [] });
    admissions[second]?.retire();
    expect(arbiter.hasReplacementInFlight(AGENT_ID)).toBe(false);
  });
});

describe('an abandoned wait gives the identity up where it becomes free', () => {
  /**
   * Ask this identity what it can do, through the handlers a real caller reaches.
   *
   * `agent.getCapabilities` is the probe because it is answered from the agent's
   * **stable** wiring — the subscriptions a connector replacement never touches —
   * and its answer names the connector behind it, so a stale handler is
   * distinguishable from a live one rather than merely present.
   * @returns The model of whichever agent answered, or `undefined` when none did
   */
  async function probeAnsweringModel(): Promise<string | undefined> {
    const probe = await MakaioBus.requestOptional(AgentSubjects.getCapabilities, { agentId: AGENT_ID });
    return probe.handled ? probe.data.model : undefined;
  }

  it('unsubscribes the abandoned agent at the expiry, so a successor answers alone before the settlement', async () => {
    const held = await abandonReplacementInFlight();

    // The wait is over and the entry is gone, so the identity is claimable from
    // this instant — which is why the agent that lost it must be unable to answer
    // *now*, and not only once the replacement it abandoned settles. The
    // replacement is still parked in `initialize()` here.
    expect(arbiter.hasReplacementInFlight(AGENT_ID)).toBe(true);
    expect(await probeAnsweringModel()).toBeUndefined();

    const successor = createTestableAgent({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      teardownArbiter: arbiter,
      initialModel: 'successor-model',
      initialCwd: os.tmpdir(),
      mockConnectorFactory: (config) => new ReentrantCloseConnector(config.model, config.cwd),
    });
    await successor.init();
    try {
      // The window a settlement-time release leaves open: both agents subscribed,
      // and the stale one registered first, so it is the one that would answer.
      expect(await probeAnsweringModel()).toBe('successor-model');

      held.release();
      await held.swap;
      await flushMicrotasks();

      // The handover closed the runtimes it inherited and cleared its own
      // connector wiring — and took nothing of the successor's down with it.
      expect(await probeAnsweringModel()).toBe('successor-model');
    } finally {
      await successor.close();
    }

    // And the successor's own end still releases everything it registered, which
    // is what makes the assertion above about the abandoned agent rather than
    // about a probe nobody answers.
    expect(await probeAnsweringModel()).toBeUndefined();
  });
});

describe('the flight is installed before any close begins', () => {
  it('lets a synchronously reentrant stop join the flight that provoked it', async () => {
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    connector.closeOutcome = { evidence: 'exited' };
    const closeGate = new DeferredPromise<void>();
    connector.closeGate = closeGate.getPromise();

    let flightSeenAtReentry: boolean | undefined;
    let reentrant: Promise<AgentDisposalReport> | undefined;
    connector.onCloseEntered = () => {
      flightSeenAtReentry = arbiter.hasTeardownInFlight(AGENT_ID);
      // Fire-and-forget, exactly as the emission that provokes this in production
      // is: awaiting it here would be a reentrant handler waiting on the close it is
      // running inside.
      reentrant = registry.dispose(AGENT_ID);
    };

    const outer = registry.dispose(AGENT_ID);
    closeGate.resolve();
    const outerReport = await outer;
    if (reentrant === undefined) throw new Error('the close never re-entered the registry');
    const reentrantReport = await reentrant;

    // The assertion clause (a) is made of: the flight was already installed when the
    // close path had begun. Installing it with the promise the body returned leaves
    // this `false`, and nothing but the emitter's scheduling to make it safe.
    expect(flightSeenAtReentry).toBe(true);
    // And the reentrant caller is answered with the incumbent's real class. This is
    // the half a close count cannot see: `AIAgent.close` detaches its runtime before
    // awaiting, so a *second* flight finds nothing to close and reports the vacuous
    // `released` while the connector's own count stays at one.
    expect(outerReport.evidence).toBe('exited');
    expect(reentrantReport.evidence).toBe('exited');
    expect(connector.closeCount).toBe(1);
    expect(await storedStatus()).toBe('disposed');
  });
});

describe('case 204e: the four agent-teardown entry points join one flight', () => {
  /** The four entry points, each as the registry exposes it. */
  const entryPoints: ReadonlyArray<{
    readonly name: string;
    /** Run the entry point and report the class it answered with. */
    readonly run: (target: ActiveAgentRegistry) => Promise<TeardownEvidence | undefined>;
    /** Whether this entry point writes a terminal status of its own. */
    readonly writesStatus: 'dead' | 'disposed' | undefined;
  }> = [
    { name: 'evict', run: async (target) => (await target.evict(AGENT_ID)).evidence, writesStatus: 'dead' },
    { name: 'dispose', run: async (target) => (await target.dispose(AGENT_ID)).evidence, writesStatus: 'disposed' },
    {
      name: 'evictSilently',
      run: async (target) => (await target.evictSilently(AGENT_ID)).evidence,
      writesStatus: undefined,
    },
    { name: 'closeAll', run: async (target) => (await target.closeAll())[0]?.evidence, writesStatus: undefined },
  ];

  it.each(entryPoints)('writes only its own status: $name', async ({ run, writesStatus }) => {
    await seedAgentRow();
    await registerLiveAgent();

    await run(registry).catch(() => undefined);

    expect(await storedStatus()).toBe(writesStatus ?? 'idle');
  });

  it.each(entryPoints)('joins a flight already installed: $name', async ({ run }) => {
    await seedAgentRow();
    const { connector } = await registerLiveAgent();
    const closeGate = new DeferredPromise<void>();
    connector.closeGate = closeGate.getPromise();
    connector.closeOutcome = { evidence: 'exited' };

    const incumbent = registry.dispose(AGENT_ID);
    await Promise.resolve();
    const joiner = run(registry);

    closeGate.resolve();
    const [incumbentReport, joinedEvidence] = await Promise.all([incumbent, joiner]);

    // One connector close for two entry points — the property the flight exists
    // for, and the one a per-entry-point guard cannot deliver.
    expect(connector.closeCount).toBe(1);
    // And the joiner is answered with the incumbent's own class. This half is what
    // catches an implementation that starts a *second* flight: the agent's own
    // close is idempotent, so the second flight would find nothing to close and
    // report the vacuous `released` while the close count stayed at one.
    expect(incumbentReport.evidence).toBe('exited');
    expect(joinedEvidence).toBe('exited');
  });

  it('leaves `disposed` effective whenever a disposal participated, in either order', async () => {
    for (const order of [
      ['dispose', 'evict'],
      ['evict', 'dispose'],
    ] as const) {
      state.agents.clear();
      arbiter = new AgentTeardownArbiter();
      registry = new ActiveAgentRegistry({ globalBus: MakaioBus, adapterName: 'flight-adapter', arbiter });
      await seedAgentRow();
      const { connector } = await registerLiveAgent();
      const closeGate = new DeferredPromise<void>();
      connector.closeGate = closeGate.getPromise();

      const runs = order.map((name) =>
        name === 'dispose' ? registry.dispose(AGENT_ID) : registry.evict(AGENT_ID).catch(() => undefined),
      );
      closeGate.resolve();
      await Promise.all(runs);

      expect(connector.closeCount).toBe(1);
      expect(await storedStatus()).toBe('disposed');
    }
  });
});
