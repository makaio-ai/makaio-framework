/**
 * Case 204f-b — every non-rehydrate producer arbitrates at the same door.
 *
 * The producer inventory is documentation, never enforcement, so what makes its
 * coverage testable rather than asserted is that each producer is driven through its
 * **own real entry point** — the agent's own bus handlers and the coordinator's own
 * public swap — and that each is a separate mandatory arm. A single arm allowing "one
 * producer or another" would be vacuous on whichever one the code cannot exhibit.
 *
 * "Before" here means a teardown flight is installed when the producer reaches the
 * prologue. It is installed by a real eviction whose connector close the test holds
 * open, so the flight is genuinely in flight rather than simulated.
 *
 * "After" means the opposite ordering, and it is **not** the mirror image: the rule
 * has one direction, so an admitted producer is never refused after the fact — the
 * teardown waits for it. What those arms pin is therefore the effect the producer
 * committed on its way through, which only the three account-carrying producers have
 * (addendum B6).
 */
import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, CredentialSubjects, type ProviderContext } from '@makaio/contracts';
import { DeferredPromise } from '@makaio/utils';
import { ActiveAgentRegistry } from '../../adapter/agent-registry.js';
import { AgentTeardownArbiter } from '../agent-teardown-arbiter.js';
import { ConnectorSwapVetoedError } from '../connector-swap-vetoed-error.js';
import type { TeardownReport } from '../../connector/teardown-report.js';
import {
  createTestableAgent,
  MockConnector,
  registerSuccessfulRuntimeMutationPersistence,
  type TestableAgent,
} from './helpers/mock-agent.js';

const AGENT_ID = 'agent-producer';
const SESSION_ID = 'session-producer';

/**
 * A provider context whose auth mode really opens an account transaction.
 *
 * Only an *inferred* selection naming a managed account produces one; explicit and
 * no-auth modes are side-effect-free, so every "the activation was rolled back"
 * assertion would be vacuous against them.
 */
const MANAGED_PROVIDER_CONTEXT: ProviderContext = {
  state: 'resolved',
  providerConfigId: 'provider-config-1',
  definitionId: 'test',
  auth: {
    mode: 'inferred',
    method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
    definition: { id: 'native', mode: 'inferred', label: 'Native client' },
    account: { managerId: 'account-manager', accountId: 'account-1' },
  },
};

/** A second real directory, so a CWD change is not a no-op early return. */
let otherCwd: string;
/**
 * A second managed selection, so a model change is really a *provider* change.
 *
 * The model producer only opens an account transaction when the selection moves to a
 * different provider config; naming the same one would leave its activation arm
 * vacuous.
 */
const OTHER_MANAGED_PROVIDER_CONTEXT: ProviderContext = {
  ...MANAGED_PROVIDER_CONTEXT,
  providerConfigId: 'provider-config-9',
};

let arbiter: AgentTeardownArbiter;
let registry: ActiveAgentRegistry;
let agent: TestableAgent;
let built: MockConnector[];
let activationEvents: string[];
/**
 * Configuration applied to the **next** connector generation at construction.
 *
 * Load-bearing for the "after" arms: a replacement initializes inside the same
 * await the producer's request is on, so a gate installed after the request was
 * issued arrives too late and the swap has already committed — which silently turns
 * "a teardown admitted after the door" into "a teardown after the swap".
 */
let nextGeneration: ((connector: MockConnector) => void) | undefined;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  otherCwd = fs.mkdtempSync(`${os.tmpdir()}/producer-arbitration-`);
  arbiter = new AgentTeardownArbiter();
  registry = new ActiveAgentRegistry({ globalBus: MakaioBus, adapterName: 'producer-adapter', arbiter });
  built = [];
  activationEvents = [];
  nextGeneration = undefined;
  cleanups.push(
    registerSuccessfulRuntimeMutationPersistence(),
    MakaioBus.on(CredentialSubjects.activation.prepare, (ctx) => {
      activationEvents.push('prepare');
      ctx.setResult({ success: true, transactionId: `activation-${activationEvents.length}` });
    }),
    MakaioBus.on(CredentialSubjects.activation.commit, (ctx) => {
      activationEvents.push('commit');
      ctx.setResult({ success: true });
    }),
    MakaioBus.on(CredentialSubjects.activation.rollback, (ctx) => {
      activationEvents.push('rollback');
      ctx.setResult({ success: true });
    }),
  );
  agent = createTestableAgent({
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    teardownArbiter: arbiter,
    initialCwd: os.tmpdir(),
    providerContext: MANAGED_PROVIDER_CONTEXT,
    mockConnectorFactory: (config) => {
      const connector = new MockConnector(config.model, config.cwd);
      // Every producer below reaches the door only because the in-place attempt
      // refuses first, which is the real path each of them takes.
      connector.changeCwdInPlaceResult = false;
      connector.changeModelInPlaceResult = false;
      connector.changeReasoningInPlaceResult = false;
      nextGeneration?.(connector);
      nextGeneration = undefined;
      built.push(connector);
      return connector;
    },
  });
  await agent.init();
  registry.set(AGENT_ID, {
    agent,
    sessionId: SESSION_ID,
    adapterSessionId: 'provider-session-1',
    usage: { totalInputTokens: 0, totalOutputTokens: 0, totalCalls: 0 },
  });
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
});

/**
 * Install a real teardown flight and keep it installed.
 * @returns A releaser for the held close, which the test must call
 */
function installTeardownFlight(): { release: () => Promise<void> } {
  const closeGate = new DeferredPromise<void>();
  const incumbent = built[0];
  if (incumbent === undefined) throw new Error('the agent built no connector');
  incumbent.closeGate = closeGate.getPromise();
  const teardown = registry.evictSilently(AGENT_ID);
  return {
    release: async () => {
      closeGate.resolve();
      await teardown;
    },
  };
}

/**
 * Arrange the one interleaving in which a producer can reach the door at all.
 *
 * A teardown unsubscribes the agent's bus handlers as its first act, so a mutation
 * *dispatched* after the flight is installed never reaches a handler — which means
 * the only reachable "teardown before the prologue" is a producer whose handler was
 * **already executing**. This holds one producer inside its own in-place attempt
 * (which runs under the agent's mutation barrier), queues the producer under test
 * behind that barrier, installs the flight, and then lets both run on.
 * @param dispatchProducer - Dispatch the producer whose refusal is under test
 * @returns The producer's answer, once the flight was installed before its prologue
 */
async function withTeardownBeforeProducer<T>(dispatchProducer: () => Promise<T>): Promise<T> {
  const incumbent = built[0];
  if (incumbent === undefined) throw new Error('the agent built no connector');
  const barrierGate = new DeferredPromise<void>();
  incumbent.changeCwdInPlaceGate = barrierGate.getPromise();
  incumbent.changeCwdInPlaceResult = true;
  const barrierHolder = MakaioBus.request(AgentSubjects.cwd.change, {
    agentId: AGENT_ID,
    adapterId: 'test-adapter',
    adapterName: 'test',
    adapterSessionId: 'test-session-id',
    newCwd: '/held-by-the-barrier',
  });
  await drain();

  const producer = dispatchProducer();
  await drain();
  const flight = installTeardownFlight();
  await drain();

  barrierGate.resolve();
  const answer = await producer;
  await barrierHolder;
  await flight.release();
  return answer;
}

/**
 * Arrange the other region: the teardown arrives **after** the producer was
 * admitted, so it waits instead of vetoing.
 *
 * The direction is one-way, so this is not the mirror of
 * {@link withTeardownBeforeProducer} — the producer is never refused here, and what
 * the arm is for is the effect it commits on its way through. The replacement's own
 * `initialize` is held so the admission is provably still open when the teardown
 * reads the map, and the arm asserts the replacement exists before releasing it.
 * @param dispatchProducer - Dispatch the producer whose committed effect is under test
 * @returns The producer's answer and the class the waiting teardown reported
 */
async function withTeardownAfterProducer<T>(
  dispatchProducer: () => Promise<T>,
): Promise<{ answer: T; teardown: TeardownReport }> {
  const initGate = new DeferredPromise<void>();
  nextGeneration = (connector) => void (connector.initializeGate = initGate.getPromise());

  const producer = dispatchProducer();
  await drain();
  // Past the door, provably: the replacement was constructed, which only happens
  // after `admitSwap` returned an admission. Without this the arm could pass with a
  // teardown that arrived before the prologue and a producer that was refused.
  expect(built).toHaveLength(2);

  const teardown = registry.evictSilently(AGENT_ID);
  await drain();
  initGate.resolve();

  const answer = await producer;
  return { answer, teardown: await teardown };
}

/** Let every queued microtask and immediate settle. */
async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('case 204f-b: each producer is refused at the same door', () => {
  it('(a) credential change: refuses, rolls the prepared activation back, commits nothing', async () => {
    const response = await withTeardownBeforeProducer(() =>
      MakaioBus.request(AgentSubjects.credential.change, {
        agentId: AGENT_ID,
        adapterId: 'test-adapter',
        adapterName: 'test',
        adapterSessionId: 'test-session-id',
        providerContext: MANAGED_PROVIDER_CONTEXT,
        changeSequence: 1,
      }),
    );

    expect(response.success).toBe(false);
    // Credential-free reason: the refusal must not leak the provider's own failure
    // vocabulary across the bus boundary.
    expect(response).toMatchObject({ reason: 'credential_swap_failed' });
    // The activation it prepared is rolled back, and **nothing was committed**.
    expect(activationEvents).toEqual(['prepare', 'rollback']);
    // No replacement runtime exists, so no provider thread was started for it.
    expect(built).toHaveLength(1);
  });

  it('(b) coordinator path: refuses and rolls its own prepared activation back', async () => {
    const refusal = await withTeardownBeforeProducer(() =>
      agent.swapConnector({ providerContext: MANAGED_PROVIDER_CONTEXT }).catch((error: unknown) => error),
    );

    expect(refusal).toBeInstanceOf(ConnectorSwapVetoedError);
    expect((refusal as ConnectorSwapVetoedError).reason).toBe('teardown-in-flight');
    expect(activationEvents).toEqual(['prepare', 'rollback']);
    expect(built).toHaveLength(1);
  });

  it('(c) model/provider mutation: refuses, rolls back, and the dialog completed outside the region', async () => {
    const dialogAnsweredAt: number[] = [];
    cleanups.push(
      MakaioBus.on(AgentSubjects.validateModelChange, (ctx) => {
        dialogAnsweredAt.push(Date.now());
        ctx.setResult({ proceed: true });
      }),
    );
    const response = await withTeardownBeforeProducer(() =>
      MakaioBus.request(AgentSubjects.model.change, {
        agentId: AGENT_ID,
        adapterId: 'test-adapter',
        adapterName: 'test',
        adapterSessionId: 'test-session-id',
        newModel: 'other-model',
        providerContext: OTHER_MANAGED_PROVIDER_CONTEXT,
      }),
    );

    expect(response.success).toBe(false);
    expect(activationEvents).toContain('rollback');
    expect(activationEvents).not.toContain('commit');
    expect(built).toHaveLength(1);
    // **The testable form of the boundedness argument**: the confirmation dialog —
    // a request to an optional host handler with no bound of its own — completed
    // before the door was reached, so it is never inside the region a teardown
    // waits on.
    expect(dialogAnsweredAt).toHaveLength(1);
  });

  it('(d) CWD mutation: refuses with its own reason and builds no replacement', async () => {
    // This producer needs no separate barrier holder: its own in-place attempt is
    // the step that runs before the door, so gating it is enough.
    const incumbent = built[0];
    if (incumbent === undefined) throw new Error('the agent built no connector');
    const inPlaceGate = new DeferredPromise<void>();
    incumbent.changeCwdInPlaceGate = inPlaceGate.getPromise();
    const pending = MakaioBus.request(AgentSubjects.cwd.change, {
      agentId: AGENT_ID,
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newCwd: otherCwd,
    });
    await drain();
    const flight = installTeardownFlight();
    await drain();
    inPlaceGate.resolve();
    const response = await pending;

    // The producer that carries no account transaction at all: it shows the refusal
    // path is not account-specific.
    expect(response).toEqual({ success: false, reason: 'cwd_change_failed: connector_replacement_failed' });
    expect(built).toHaveLength(1);

    await flight.release();
  });

  it('(e) MCP mutation: refuses, and the staged replacement is lost', async () => {
    const response = await withTeardownBeforeProducer(() =>
      MakaioBus.request(AgentSubjects.mcp.servers.set, {
        agentId: AGENT_ID,
        adapterId: 'test-adapter',
        adapterName: 'test',
        adapterSessionId: 'test-session-id',
        mcpSessionContext: { sessionId: SESSION_ID, servers: [], directTools: [], discoverableTools: [] },
        turnActiveBehavior: 'reject',
      }),
    );

    // Pinned as the specified behaviour rather than discovered later: the staged
    // value was cleared before the swap was attempted, so a vetoed staged
    // replacement is *lost*. It leaves no resource, no provider session, no durable
    // account transition and no delivered event behind — and it only happens on an
    // agent a teardown is concurrently destroying.
    expect(response).toEqual({ success: false, reason: 'mcp_servers_set_failed: connector_replacement_failed' });
    expect(built).toHaveLength(1);
  });

  it('(f) an in-place mutation installs no replacement entry at all', async () => {
    // Round 8's unused-entry question, answered by construction rather than by a
    // discard rule: the entry is installed at the moment a replacement begins, so a
    // producer that never needs one installs nothing — and is therefore never
    // refused by the door either.
    const connector = built[0];
    if (connector === undefined) throw new Error('the agent built no connector');
    connector.changeCwdInPlaceResult = true;
    const inPlaceGate = new DeferredPromise<void>();
    connector.changeCwdInPlaceGate = inPlaceGate.getPromise();
    const pending = MakaioBus.request(AgentSubjects.cwd.change, {
      agentId: AGENT_ID,
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      newCwd: otherCwd,
    });
    await drain();
    const flight = installTeardownFlight();
    await drain();
    inPlaceGate.resolve();
    const response = await pending;

    // It succeeded *while a teardown was in flight*, because it never reached the
    // door: an in-place change is not a replacement.
    expect(response.success).toBe(true);
    expect(built).toHaveLength(1);

    await flight.release();
  });
});

/**
 * Case 204f-b's "after" halves for the three producers that commit an account
 * activation (addendum B6).
 *
 * The structural coverage of this region — 204f arm 2 — asserts that the swap
 * completed and the two runtimes found two owners. It cannot see what these three
 * producers *additionally* do: move a managed account. So each arm here asserts the
 * committed transition **positively**, which round 6 established as as load-bearing
 * as the absences the "before" arms assert. CWD and MCP own no such transition and
 * are deliberately absent: their "after" is only "the swap completed", and a
 * duplicate of arm 2 would pin nothing new.
 */
describe('case 204f-b: each account-carrying producer commits a transition that stands', () => {
  /**
   * The assertion all three arms share: committed, never rolled back, and the
   * teardown that waited did answer.
   * @param teardown - Class the waiting teardown reported
   */
  function expectCommittedTransitionStands(teardown: TeardownReport): void {
    // Exactly one activation, committed. Asserted as the whole sequence rather than
    // "contains commit", because a producer that committed *and then* rolled back
    // would satisfy the weaker form while leaving the account somewhere else.
    expect(activationEvents).toEqual(['prepare', 'commit']);
    // The teardown waited for the settlement and then closed the runtime the swap
    // published — so the agent is gone and the account transition still stands. That
    // pair is the honest outcome, and neither half may be quietly dropped.
    expect(teardown.evidence).toBe('released');
    expect(built).toHaveLength(2);
    expect(built[1]?.closeCount).toBe(1);
  }

  it('(a) credential change: the committed account transition stands', async () => {
    const { answer, teardown } = await withTeardownAfterProducer(() =>
      MakaioBus.request(AgentSubjects.credential.change, {
        agentId: AGENT_ID,
        adapterId: 'test-adapter',
        adapterName: 'test',
        adapterSessionId: 'test-session-id',
        providerContext: MANAGED_PROVIDER_CONTEXT,
        changeSequence: 1,
      }),
    );

    expect(answer).toMatchObject({ success: true, swapped: true });
    expectCommittedTransitionStands(teardown);
  });

  it('(b) coordinator path: the activation it committed stands', async () => {
    const { answer, teardown } = await withTeardownAfterProducer(() =>
      agent.swapConnector({ providerContext: MANAGED_PROVIDER_CONTEXT }).then(
        () => 'resolved',
        (error: unknown) => error,
      ),
    );

    // The public swap was admitted and is not refused after the fact: the teardown
    // waits for it, it does not veto it.
    expect(answer).toBe('resolved');
    expectCommittedTransitionStands(teardown);
  });

  it('(c) model/provider mutation: the provider transition it committed stands', async () => {
    cleanups.push(
      MakaioBus.on(AgentSubjects.validateModelChange, (ctx) => {
        ctx.setResult({ proceed: true });
      }),
    );

    const { answer, teardown } = await withTeardownAfterProducer(() =>
      MakaioBus.request(AgentSubjects.model.change, {
        agentId: AGENT_ID,
        adapterId: 'test-adapter',
        adapterName: 'test',
        adapterSessionId: 'test-session-id',
        newModel: 'other-model',
        providerContext: OTHER_MANAGED_PROVIDER_CONTEXT,
      }),
    );

    expect(answer).toMatchObject({ success: true, swapped: true, model: 'other-model' });
    expectCommittedTransitionStands(teardown);
  });
});
