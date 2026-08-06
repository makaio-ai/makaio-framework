/**
 * Cases 204f, 204h and 204i — the arbitration door, driven through the one
 * producer whose refusal has a modelled answer.
 *
 * Everything here runs against a real `AIAdapter`: real `startAgent`, real
 * `rehydrateAgent`, real `stopAgent`, real memory agent storage. The subject is the
 * boundary between a teardown and a connector replacement, so neither side is
 * stubbed — a double for either would decide the arbitration the case is meant to
 * observe.
 */
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';
import {
  createSessionStorageMemoryState,
  registerMemoryAgentStorage,
  type SessionStorageMemoryState,
} from '@makaio/services-core/session';
import { DeferredPromise } from '@makaio/utils';
import type { BaseAgentConnectorConfig } from '../../agent/types.js';
import { AgentTeardownArbiter } from '../../agent/agent-teardown-arbiter.js';
import { ConnectorSwapVetoedError } from '../../agent/connector-swap-vetoed-error.js';
import { createTestableAgent, MockConnector as AgentMockConnector } from '../../agent/__tests__/helpers/mock-agent.js';
import { ActiveAgentRegistry } from '../agent-registry.js';
import { createTestAdapter, MockConnector, registerStartReservationAuthority, type TestAdapter } from './shared.js';

let state: SessionStorageMemoryState;
let adapter: TestAdapter;
let connectors: MockConnector[];
let configFactoryFailure: Error | undefined;
/**
 * Configuration applied to the **next** connector generation at construction.
 *
 * Load-bearing: a replacement initializes inside the same await the rehydrate
 * request is on, so a gate installed after the request was issued arrives too
 * late and the swap has already committed — which silently turns every
 * "teardown admitted after the door" arm into "teardown after the swap".
 */
let nextGeneration: ((connector: MockConnector) => void) | undefined;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  state = createSessionStorageMemoryState();
  configFactoryFailure = undefined;
  cleanups.push(registerMemoryAgentStorage(MakaioBus, state), registerStartReservationAuthority());
  connectors = [];
  nextGeneration = undefined;
  ({ adapter } = createTestAdapter('arbitration-adapter', {
    configFactory: async (input) => {
      if (configFactoryFailure !== undefined) throw configFactoryFailure;
      return {
        bus: adapterScopedBus,
        agentId: input.agentId ?? 'agent',
        adapterId: input.adapterId ?? 'adapter',
        adapterName: 'arbitration-adapter',
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? os.tmpdir(),
      };
    },
    connectorFactory: (config: BaseAgentConnectorConfig & { adapterId: string }) => {
      const connector = new MockConnector(config);
      nextGeneration?.(connector);
      nextGeneration = undefined;
      connectors.push(connector);
      return connector;
    },
  }));
  adapterScopedBus = adapter['adapterBus'];
  await adapter.init();
});

// Assigned from the adapter the factory above is wired into; the config factory
// runs only after construction, so the late binding is safe.
let adapterScopedBus: BaseAgentConnectorConfig['bus'];

afterEach(async () => {
  await adapter.closeAsync();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
});

/**
 * Start one agent and return its identity and first connector generation.
 * @returns The agent id and the generation the start built
 */
async function startAgent(): Promise<{ agentId: string; incumbent: MockConnector }> {
  const result = await MakaioBus.request(AdapterSubjects.startAgent, {
    adapterId: adapter.adapterId,
    role: 'lead',
    mode: 'create',
  });
  if (!result.success) throw new Error(result.message ?? 'start refused');
  const incumbent = connectors[0];
  if (incumbent === undefined) throw new Error('the start built no connector');
  return { agentId: result.agentId, incumbent };
}

/**
 * Issue a warm rehydrate for a registered agent.
 * @param agentId - Agent to rehydrate in place
 * @returns The rehydrate response
 */
function rehydrate(agentId: string): Promise<{ success: boolean; message?: string; dispatch?: string }> {
  return MakaioBus.request(AdapterSubjects.rehydrateAgent, { adapterId: adapter.adapterId, agentId });
}

/** Let every queued microtask and immediate settle. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('case 204f arm 1: a teardown installed before the prologue makes the door refuse', () => {
  it('answers `not-dispatched`, builds no replacement, and starts no provider thread', async () => {
    const { agentId, incumbent } = await startAgent();
    const started: string[] = [];
    cleanups.push(
      MakaioBus.on(AgentSubjects.started, (ctx) => {
        started.push(ctx.payload.agentId);
      }),
    );
    // Hold the teardown's own close open, so its flight is installed and still
    // in flight when the door's prologue reads the map.
    const closeGate = new DeferredPromise<void>();
    incumbent.closeGate = closeGate.getPromise();
    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    await drain();

    const response = await rehydrate(agentId);

    expect(response).toMatchObject({ success: false, dispatch: 'not-dispatched' });
    // No replacement runtime: the door refuses before `createReplacementRuntime`.
    expect(connectors).toHaveLength(1);
    // And no provider-side thread and no lifecycle emission followed from it.
    expect(started).toEqual([]);

    closeGate.resolve();
    await stop;
  });
});

describe('case 204f arms 2-5: a teardown admitted after the door waits for the settlement', () => {
  it('arm 2: a committed settlement leaves two closes with two owners', async () => {
    const { agentId, incumbent } = await startAgent();
    const initGate = new DeferredPromise<void>();
    nextGeneration = (connector) => void (connector.initializeGate = initGate.getPromise());
    const pending = rehydrate(agentId);
    await drain();
    const replacement = connectors[1];
    if (replacement === undefined) throw new Error('the swap built no replacement');

    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    await drain();
    initGate.resolve();

    const [rehydrateOutcome, stopped] = await Promise.all([pending.catch((error: unknown) => error), stop]);

    expect(stopped.success).toBe(true);
    // The rehydrate's own answer is asserted **positively**, not merely allowed to
    // be anything: the teardown wins the published runtime, so the producer's
    // post-swap bookkeeping finds no connector and stays uncertain. That is true,
    // and it is the pre-existing caller-owned window rather than something the
    // arbitration decides — but an unasserted honest outcome is one refactor away
    // from becoming a claimed one, so uncertainty is pinned and a false success is
    // ruled out.
    expect(rehydrateOutcome).toBeInstanceOf(Error);
    expect(String(rehydrateOutcome)).not.toContain('not-dispatched');
    //
    // The swap closed the runtime it superseded; the teardown closed the one the
    // swap published. Two resources, two closes, two owners.
    expect(incumbent.closeCount).toBe(1);
    expect(replacement.closeCount).toBe(1);
  });

  it('arm 3: a rolled-back settlement leaves the teardown closing the old runtime', async () => {
    const { agentId, incumbent } = await startAgent();
    const initGate = new DeferredPromise<void>();
    nextGeneration = (connector) => {
      connector.initializeGate = initGate.getPromise();
      connector.initializeFailure = new Error('replacement initialization refused');
    };
    const pending = rehydrate(agentId);
    await drain();
    const replacement = connectors[1];
    if (replacement === undefined) throw new Error('the swap built no replacement');

    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    await drain();
    initGate.resolve();

    const [rehydrated, stopped] = await Promise.all([pending.catch((error: unknown) => error), stop]);

    // The settlement resolved `rolled-back` **without rejecting** — the waiter was
    // answered rather than made to interpret an exception — and the teardown then
    // closed the runtime that is current for that outcome: the old one.
    expect(stopped.success).toBe(true);
    expect(incumbent.closeCount).toBe(1);
    expect(replacement.closeCount).toBe(1); // closed by the swap's own rollback
    expect(rehydrated).toBeInstanceOf(Error);
  });

  it('arm 4: a rollback that itself fails is still `rolled-back`, and never a safe veto', async () => {
    const { agentId, incumbent } = await startAgent();
    const initGate = new DeferredPromise<void>();
    nextGeneration = (connector) => {
      connector.initializeGate = initGate.getPromise();
      connector.initializeFailure = new Error('replacement initialization refused');
      connector.closeOutcome = new Error('replacement close refused too');
    };
    const pending = rehydrate(agentId);
    await drain();
    const replacement = connectors[1];
    if (replacement === undefined) throw new Error('the swap built no replacement');

    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    await drain();
    initGate.resolve();

    const [rehydrateOutcome, stopped] = await Promise.all([pending.catch((error: unknown) => error), stop]);

    // The waiter still got an answer, and the teardown still closed the old runtime.
    expect(stopped.success).toBe(true);
    expect(incumbent.closeCount).toBe(1);
    // The compound failure reached the producer's own channel and was **not**
    // re-classified as the door's typed refusal, so the rehydrate stays uncertain.
    expect(rehydrateOutcome).toBeInstanceOf(Error);
    expect(String(rehydrateOutcome)).not.toContain('not-dispatched');
  });

  it('arm 5: `unclosed` is honoured on a committed settlement whose previous close failed', async () => {
    const { agentId, incumbent } = await startAgent();
    // The swap will publish its replacement and then fail to close the runtime it
    // superseded, which is exactly the handle a teardown reading only `outcome`
    // would leave running.
    incumbent.closeOutcome = new Error('superseded close refused');
    const initGate = new DeferredPromise<void>();
    nextGeneration = (connector) => void (connector.initializeGate = initGate.getPromise());
    const pending = rehydrate(agentId);
    await drain();
    const replacement = connectors[1];
    if (replacement === undefined) throw new Error('the swap built no replacement');

    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    await drain();
    initGate.resolve();

    const [rehydrateOutcome, stopped] = await Promise.all([pending.catch((error: unknown) => error), stop]);

    // Same positive assertion as arm 2: the rehydrate's answer is uncertain, never
    // a false success and never the door's typed refusal.
    expect(rehydrateOutcome).toBeInstanceOf(Error);
    expect(String(rehydrateOutcome)).not.toContain('not-dispatched');
    // The teardown closed the replacement *and* re-closed the handle the swap
    // reported as unclosed — two attempts on the superseded generation.
    expect(replacement.closeCount).toBe(1);
    expect(incumbent.closeCount).toBe(2);
    // Its own re-close failed too, so the aggregate class is `unknown` — never a
    // stronger class, and never a third settlement outcome.
    expect(stopped.evidence).toBe('unknown');
  });

  it('arm 6: a committed settlement whose superseded close was weak but clean caps the stop', async () => {
    const { agentId, incumbent } = await startAgent();
    // The arm arm 5 does not reach: the superseded close **fails nothing** and
    // still proves nothing. `detached` is the ordinary answer of a process
    // connector that signalled a kill it did not observe land, so this is the
    // normal shape of a swap on such an adapter rather than a fault — and it
    // appears in neither `closeError` nor `unclosed`.
    incumbent.closeOutcome = { evidence: 'detached', detail: 'kill signalled, exit unobserved' };
    const initGate = new DeferredPromise<void>();
    nextGeneration = (connector) => void (connector.initializeGate = initGate.getPromise());
    const pending = rehydrate(agentId);
    await drain();
    const replacement = connectors[1];
    if (replacement === undefined) throw new Error('the swap built no replacement');

    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    await drain();
    initGate.resolve();

    const [, stopped] = await Promise.all([pending.catch((error: unknown) => error), stop]);

    // Exactly one close each, and no re-close: nothing needed closing.
    expect(incumbent.closeCount).toBe(1);
    expect(replacement.closeCount).toBe(1);
    // The teardown's own close was clean, so every stronger class here would come
    // from ignoring the report the swap made. The stop answers for the *agent*, and
    // one of the agent's runtimes ended unobserved.
    expect(stopped.success).toBe(true);
    expect(stopped.evidence).toBe('detached');
  });
});

describe('case 204f arm 7: a settlement nobody waited for still binds the agent', () => {
  it('caps a later stop at the class the rollback close of the replacement reported', async () => {
    const { agentId, incumbent } = await startAgent();
    // The arm arm 6 does not reach: same weak-but-clean close, but **no teardown is
    // in flight at all**, so the settlement carrying that class has no consumer. The
    // agent survives the rollback and keeps serving on the runtime it restored,
    // while a generation of the replacement may still be running.
    nextGeneration = (connector) => {
      connector.initializeFailure = new Error('replacement initialization refused');
      connector.closeOutcome = { evidence: 'detached', detail: 'kill signalled, exit unobserved' };
    };

    const rehydrated = await rehydrate(agentId).catch((error: unknown) => error);
    // No waiter, so the replacement's rollback is the producer's own failure and
    // nothing else: the agent is still registered and still holds the old runtime.
    expect(rehydrated).toBeInstanceOf(Error);
    const replacement = connectors[1];
    if (replacement === undefined) throw new Error('the swap built no replacement');
    expect(replacement.closeCount).toBe(1);

    const stopped = await MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });

    // The stop's own close was clean — the incumbent reports `released` — so
    // `released` is exactly the comfortable answer that ignoring the discarded
    // report would produce. The stop answers for the *agent*, and one runtime this
    // agent started ended unobserved.
    expect(stopped.success).toBe(true);
    expect(incumbent.closeCount).toBe(1);
    expect(stopped.evidence).toBe('detached');
    expect(stopped.detail).toContain('exit unobserved');
  });
});

describe('case 204i: a producer that throws after admission still settles the entry', () => {
  it('resolves `rolled-back` and lets a waiting teardown proceed when initialize rejects', async () => {
    const { agentId, incumbent } = await startAgent();
    const initGate = new DeferredPromise<void>();
    nextGeneration = (connector) => {
      connector.initializeGate = initGate.getPromise();
      connector.initializeFailure = new Error('initialize refused');
    };
    const pending = rehydrate(agentId);
    await drain();

    // The teardown is **already waiting** when the replacement fails, so a missing
    // settlement in the door's `finally` hangs this test rather than passing it.
    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    await drain();
    initGate.resolve();

    const [, stopped] = await Promise.all([pending.catch(() => undefined), stop]);

    expect(stopped.success).toBe(true);
    expect(stopped.evidence).not.toBe('unknown');
    expect(incumbent.closeCount).toBe(1);
  });

  it('settles even when the config factory of the next generation rejects', async () => {
    // The earliest post-admission step that can reject, and the one no connector
    // is involved in: the door has already installed its entry when it runs.
    const { agentId, incumbent } = await startAgent();
    configFactoryFailure = new Error('config factory refused');
    const pending = rehydrate(agentId);
    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });

    const [, stopped] = await Promise.all([pending.catch(() => undefined), stop]);

    expect(stopped.success).toBe(true);
    expect(connectors).toHaveLength(1);
    expect(incumbent.closeCount).toBe(1);
  });
});

describe('case 204h: the door refuses after a teardown has already finished', () => {
  it('refuses with the typed veto, and builds no replacement for a runtime-less agent', async () => {
    // A finished teardown removes its flight entry, so the refusal cannot come from
    // the flight map: it has to come from the door's runtime-presence read. The
    // producer here is one that still holds the agent — the shape round 8 named.
    const arbiter = new AgentTeardownArbiter();
    const built: AgentMockConnector[] = [];
    const agent = createTestableAgent({
      agentId: 'agent-204h',
      teardownArbiter: arbiter,
      mockConnectorFactory: (config) => {
        const connector = new AgentMockConnector(config.model, config.cwd);
        built.push(connector);
        return connector;
      },
    });
    await agent.init();
    expect(built).toHaveLength(1);

    await agent.close({ emitSessionClosed: false });
    expect(arbiter.hasTeardownInFlight('agent-204h')).toBe(false);

    const refusal = await agent.swapConnector({ cwd: os.tmpdir() }).catch((error: unknown) => error);

    // Half one: the refusal is **typed**, which is what lets the warm path answer
    // `not-dispatched` instead of leaving its caller uncertain.
    expect(refusal).toBeInstanceOf(ConnectorSwapVetoedError);
    expect((refusal as ConnectorSwapVetoedError).reason).toBe('no-runtime');
    // Half two: no replacement was built. Asserted separately because the untyped
    // throw this replaces already prevented the replacement, and a class-only
    // assertion would stay green against it.
    expect(built).toHaveLength(1);
  });
});

describe('the door reads the teardown map first, and its two refusals are distinct', () => {
  it('refuses with `teardown-in-flight` while a flight is installed', async () => {
    // Both preconditions hold at once here — the flight is installed *and* the
    // agent's runtime is already detached — so the reported reason is what proves
    // the ordering: a door that only read the runtime would answer `no-runtime`,
    // and would then keep answering it for an agent a *waiting* teardown has not
    // detached anything from yet.
    const arbiter = new AgentTeardownArbiter();
    const registry = new ActiveAgentRegistry({ globalBus: MakaioBus, adapterName: 'arbitration-adapter', arbiter });
    const built: AgentMockConnector[] = [];
    const closeGate = new DeferredPromise<void>();
    const agent = createTestableAgent({
      agentId: 'agent-door-order',
      teardownArbiter: arbiter,
      mockConnectorFactory: (config) => {
        const connector = new AgentMockConnector(config.model, config.cwd);
        if (built.length === 0) connector.closeGate = closeGate.getPromise();
        built.push(connector);
        return connector;
      },
    });
    await agent.init();
    registry.set('agent-door-order', {
      agent,
      sessionId: 'session-door-order',
      adapterSessionId: 'provider-session',
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
    });

    const teardown = registry.evictSilently('agent-door-order');
    await drain();
    expect(arbiter.hasTeardownInFlight('agent-door-order')).toBe(true);

    const refusal = await agent.swapConnector({ cwd: os.tmpdir() }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConnectorSwapVetoedError);
    expect((refusal as ConnectorSwapVetoedError).reason).toBe('teardown-in-flight');
    expect(built).toHaveLength(1);

    closeGate.resolve();
    await teardown;
  });
});
