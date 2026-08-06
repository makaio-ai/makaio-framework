/**
 * Case 228 — the teardown's wait on a connector replacement is bounded, and expiry
 * hands the resources back.
 *
 * **Controlled time is prescribed here, not chosen.** The ceiling is ten seconds, so
 * an arm that really slept would be a ten-second test and the next person would
 * delete it. And the clock must be *one* clock: the bus mints its deadline from the
 * global `Date.now()` and enforces it with a timer, so a test that advanced only an
 * arbiter-local clock would expire the inner wait while the outer timer had barely
 * moved — a false green, and precisely the interleaving arm 5 exists to disprove.
 */
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import {
  createSessionStorageMemoryState,
  registerMemoryAgentStorage,
  type SessionStorageMemoryState,
} from '@makaio/services-core/session';
import { DeferredPromise } from '@makaio/utils';
import { AgentTeardownArbiter } from '../../agent/agent-teardown-arbiter.js';
import { CONNECTOR_EXIT_OBSERVATION_MS, SWAP_SETTLEMENT_WAIT_MS } from '../../connector/teardown-timing.js';
import { createTestableAgent, MockConnector, type TestableAgent } from '../../agent/__tests__/helpers/mock-agent.js';
import { ActiveAgentRegistry } from '../agent-registry.js';
import {
  createTestAdapter,
  MockConnector as AdapterMockConnector,
  registerStartReservationAuthority,
} from './shared.js';

const AGENT_ID = 'agent-bound';
const SESSION_ID = 'session-bound';

let state: SessionStorageMemoryState;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  // Global fake timers: `Date.now`, `setTimeout` and therefore the bus's own
  // `pTimeout` all move together.
  vi.useFakeTimers();
  state = createSessionStorageMemoryState();
  cleanups.push(registerMemoryAgentStorage(MakaioBus, state));
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
  vi.useRealTimers();
});

/**
 * Drain the microtask queue without touching the clock.
 *
 * Deliberately not `advanceTimersByTimeAsync`: arm 6 asserts that no wait timer was
 * created at all, and any clock movement would let one fire.
 */
async function flushMicrotasks(): Promise<void> {
  for (let hop = 0; hop < 32; hop += 1) await Promise.resolve();
}

/** An agent with a replacement in flight that the test releases when it chooses. */
interface HeldSwap {
  readonly arbiter: AgentTeardownArbiter;
  readonly registry: ActiveAgentRegistry;
  readonly agent: TestableAgent;
  readonly incumbent: MockConnector;
  /** The replacement generation, once the swap has built it. */
  readonly replacement: () => MockConnector | undefined;
  /** Let the held replacement finish initializing. */
  readonly release: () => void;
  /** The swap's own promise, so a test can await its completion. */
  readonly swap: Promise<unknown>;
}

/**
 * Register one agent and put a connector replacement in flight on it.
 * @returns Handles for the arbitration both acts run through
 */
async function withHeldSwap(): Promise<HeldSwap> {
  const arbiter = new AgentTeardownArbiter();
  const registry = new ActiveAgentRegistry({ globalBus: MakaioBus, adapterName: 'bound-adapter', arbiter });
  const built: MockConnector[] = [];
  const initGate = new DeferredPromise<void>();
  const agent = createTestableAgent({
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    teardownArbiter: arbiter,
    initialCwd: os.tmpdir(),
    mockConnectorFactory: (config) => {
      const connector = new MockConnector(config.model, config.cwd);
      // Only the replacement is held: the incumbent has to finish initializing for
      // the agent to exist at all.
      if (built.length > 0) connector.initializeGate = initGate.getPromise();
      built.push(connector);
      return connector;
    },
  });
  await agent.init();
  const incumbent = built[0];
  if (incumbent === undefined) throw new Error('the agent built no connector');
  registry.set(AGENT_ID, {
    agent,
    sessionId: SESSION_ID,
    adapterSessionId: 'provider-session-1',
    usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
  });

  const swap = agent.swapConnector({ cwd: os.tmpdir() }).catch(() => undefined);
  // The replacement is built and then parked inside `initialize()`, so the swap is
  // provably unsettled while the teardown below arbitrates against it.
  await vi.advanceTimersByTimeAsync(0);
  if (built.length !== 2) throw new Error('the swap built no replacement');

  return {
    arbiter,
    registry,
    agent,
    incumbent,
    replacement: () => built[1],
    release: () => initGate.resolve(),
    swap,
  };
}

describe('case 228 arm 1: a settlement inside the bound keeps region-two behaviour', () => {
  it('closes the runtime that is current for the outcome once the swap settles in time', async () => {
    const held = await withHeldSwap();

    const teardown = held.registry.evictSilently(AGENT_ID);
    await vi.advanceTimersByTimeAsync(SWAP_SETTLEMENT_WAIT_MS / 2);
    held.release();
    await held.swap;
    const report = await teardown;

    // Settled in time, so the teardown really closed something and the class is
    // not the expiry arm's `unknown`.
    expect(report.evidence).not.toBe('unknown');
    expect(held.replacement()?.closeCount).toBe(1);
    expect(held.incumbent.closeCount).toBe(1);
  });
});

describe('case 228 arms 2-4: expiry closes nothing and hands both runtimes back', () => {
  it('arm 2: reports `unknown` naming the unsettled swap and closes nothing', async () => {
    const held = await withHeldSwap();

    const teardown = held.registry.evictSilently(AGENT_ID);
    await vi.advanceTimersByTimeAsync(SWAP_SETTLEMENT_WAIT_MS + 1);
    const report = await teardown;

    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('connector replacement');
    // **Zero for both runtimes.** Closing the old one under a still-running
    // replacement is the orphan the refusal region exists to prevent, and this
    // count is the arm that fails an implementation which does it anyway.
    expect(held.incumbent.closeCount).toBe(0);
    expect(held.replacement()?.closeCount).toBe(0);
  });

  it('arm 3: a slow but healthy swap then closes both runtimes itself', async () => {
    const held = await withHeldSwap();

    const teardown = held.registry.evictSilently(AGENT_ID);
    await vi.advanceTimersByTimeAsync(SWAP_SETTLEMENT_WAIT_MS + 1);
    await teardown;
    expect(held.incumbent.closeCount).toBe(0);

    // The swap is **healthy**, only slow — expiry against a legal replacement is a
    // specified normal path, so the handover is the ordinary lid rather than an
    // anomaly's backstop.
    held.release();
    await held.swap;
    await vi.advanceTimersByTimeAsync(0);

    // Both: the superseded runtime it always closed, and the one it would
    // otherwise have handed to the waiter that is gone.
    expect(held.incumbent.closeCount).toBe(1);
    expect(held.replacement()?.closeCount).toBe(1);
  });

  it('arm 4: the released swap publishes no replacement anyone can reach', async () => {
    const held = await withHeldSwap();

    const teardown = held.registry.evictSilently(AGENT_ID);
    await vi.advanceTimersByTimeAsync(SWAP_SETTLEMENT_WAIT_MS + 1);
    await teardown;
    held.release();
    await held.swap;
    await vi.advanceTimersByTimeAsync(0);

    // Asserted on the registry, since the entry is already gone: nothing routes to
    // the replacement the swap published.
    expect(held.registry.get(AGENT_ID)).toBeUndefined();
    expect(held.arbiter.hasTeardownInFlight(AGENT_ID)).toBe(false);
  });
});

describe('case 228 arm 6: a deadline already inside the margin yields a zero wait', () => {
  it('resolves without the test advancing the clock at all, and still hands over', async () => {
    const held = await withHeldSwap();
    // One millisecond less budget than the margin, so the clamp yields zero.
    const deadline = Date.now() + CONNECTOR_EXIT_OBSERVATION_MS - 1;

    let settled = false;
    const teardown = held.registry.evictSilently(AGENT_ID, { deadline }).then((report) => {
      settled = true;
      return report;
    });
    // Microtasks only — no `advanceTimersByTime` anywhere. Under fake timers this is
    // the non-vacuous form of "zero wait": any implementation that waits must be
    // given time to do so, and this test never gives it any. It also fails an
    // implementation that clamps to a negative wait and then waits the full ceiling.
    await flushMicrotasks();
    expect(settled).toBe(true);

    const report = await teardown;
    expect(report.evidence).toBe('unknown');
    expect(held.incumbent.closeCount).toBe(0);
    expect(held.replacement()?.closeCount).toBe(0);

    // And "no budget" is still arbitration, not a licence to skip it: the swap
    // inherits both runtimes exactly as it does after a full-ceiling expiry.
    held.release();
    await held.swap;
    await vi.advanceTimersByTimeAsync(0);
    expect(held.incumbent.closeCount).toBe(1);
    expect(held.replacement()?.closeCount).toBe(1);
  });
});

describe('case 228 arm 5: end-to-end through the real stopAgent request', () => {
  it('answers the specified response inside the caller deadline it was clamped against', async () => {
    const connectors: AdapterMockConnector[] = [];
    const initGate = new DeferredPromise<void>();
    // Armed immediately before the swap, because the generation it gates does not
    // exist yet: a replacement initializes inside the same await the swap is on, so
    // there is no moment afterwards at which a gate could still be installed.
    let gateNextGeneration = false;
    cleanups.push(registerStartReservationAuthority());
    const { adapter } = createTestAdapter('bound-adapter', {
      connectorFactory: (config) => {
        const connector = new AdapterMockConnector(config);
        if (gateNextGeneration) {
          gateNextGeneration = false;
          connector.initializeGate = initGate.getPromise();
        }
        connectors.push(connector);
        return connector;
      },
    });
    await adapter.init();
    const started = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'create',
    });
    if (!started.success) throw new Error(started.message ?? 'start refused');

    // A **legal** replacement, held open by the test: it is slow, not broken.
    const agentHandle = adapter.getAgent(started.agentId);
    if (agentHandle === undefined) throw new Error('the start registered no agent');
    gateNextGeneration = true;
    const swap = agentHandle.agent.swapConnector({ cwd: os.tmpdir() }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    // The caller's own timeout is set **below** the ceiling, so the clamp against
    // `ctx.deadline` is what makes this arm pass at all.
    const callerTimeoutMs = 5_000;
    const clampedWaitMs = callerTimeoutMs - CONNECTOR_EXIT_OBSERVATION_MS;
    expect(clampedWaitMs).toBeLessThan(SWAP_SETTLEMENT_WAIT_MS);

    const requestedAt = Date.now();
    let response: { success: boolean; evidence: string } | undefined;
    let respondedAt: number | undefined;
    let rejection: unknown;
    const stop = MakaioBus.request(
      AdapterSubjects.stopAgent,
      { adapterId: adapter.adapterId, agentId: started.agentId },
      { timeout: callerTimeoutMs },
    ).then(
      (result) => {
        response = result;
        respondedAt = Date.now();
      },
      (error: unknown) => void (rejection = error),
    );

    // **After** the clamped inner expiry and **before** the outer deadline. Both
    // halves of that ordering are the assertion: the response must exist in the
    // window where the seam claims it, not merely somewhere before the caller
    // gives up.
    await vi.advanceTimersByTimeAsync(clampedWaitMs + 1);
    await stop;

    expect(rejection).toBeUndefined();
    expect(response).toMatchObject({ success: true, evidence: 'unknown' });
    // The two halves of the ordering: the answer exists only *after* the clamped
    // inner expiry, and it exists *before* the caller's own deadline.
    expect(respondedAt).toBeGreaterThanOrEqual(requestedAt + clampedWaitMs);
    expect(respondedAt).toBeLessThan(requestedAt + callerTimeoutMs);
    // What this gates, precisely: the **wait's** behaviour. The post-wait tail is
    // unbounded in production, so a green arm here is not proof that every caller
    // always receives the response — this storage backend's tail is instant.

    initGate.resolve();
    await swap;
    await adapter.closeAsync();
  });
});
