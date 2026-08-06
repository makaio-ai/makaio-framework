/**
 * Case 204c and the `stopAgent` answer — the flight seen from outside the adapter.
 *
 * Driven through the real `AdapterSubjects.stopAgent` request against a real
 * `AIAdapter`, so the reentrancy the case is about is the adapter's own: the agent
 * emits `agent.session.closed` *before* its connector teardown, and the adapter's
 * own handler evicts on that event. Nothing composes a stand-in for that wiring,
 * because the wiring is the subject.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import {
  createSessionStorageMemoryState,
  registerMemoryAgentStorage,
  type SessionStorageMemoryState,
} from '@makaio/services-core/session';
import { DeferredPromise } from '@makaio/utils';
import type { TeardownReport } from '../../connector/teardown-report.js';
import {
  createTestAdapter,
  MockConnector,
  registerStartReservationAuthority,
  TestAgent,
  type TestAdapter,
} from './shared.js';

/**
 * A real agent that counts how often its teardown was entered.
 *
 * **The count has to be taken here, not on the connector.** `AIAgent.close`
 * detaches its runtime before awaiting the close, so a *second* teardown of one
 * agent finds nothing to close and reports `released` — leaving the connector's
 * own close count at one whether or not the flight joined. Counting the agent
 * teardown is what makes "one flight" observable; the behaviour itself is the real
 * one, delegated to unchanged.
 */
class CountingTeardownAgent extends TestAgent {
  public teardownCount = 0;

  /**
   * Count this teardown and run the real one.
   * @param options - Lifecycle emission controls, passed through unchanged
   * @returns Whatever the real teardown observed
   */
  public override async close(options: { emitSessionClosed?: boolean } = {}): Promise<TeardownReport> {
    this.teardownCount += 1;
    return super.close(options);
  }
}

let state: SessionStorageMemoryState;
let adapter: TestAdapter;
let connectors: MockConnector[];
let agents: CountingTeardownAgent[];
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  state = createSessionStorageMemoryState();
  cleanups.push(registerMemoryAgentStorage(MakaioBus, state), registerStartReservationAuthority());
  connectors = [];
  agents = [];
  ({ adapter } = createTestAdapter('flight-adapter', {
    agentFactory: (config) => {
      const agent = new CountingTeardownAgent(config);
      agents.push(agent);
      return agent;
    },
    connectorFactory: (config) => {
      const connector = new MockConnector(config);
      connectors.push(connector);
      return connector;
    },
  }));
  await adapter.init();
});

afterEach(async () => {
  await adapter.closeAsync();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
});

/**
 * Start one agent through the real start RPC.
 * @returns The started agent's identifier
 */
async function startAgent(): Promise<string> {
  const result = await MakaioBus.request(AdapterSubjects.startAgent, {
    adapterId: adapter.adapterId,
    role: 'lead',
    mode: 'create',
  });
  if (!result.success) throw new Error(result.message ?? 'start refused');
  return result.agentId;
}

describe('case 204c: the reentrant close joins its own emitter', () => {
  it('produces exactly one connector close when the lifecycle handler evicts', async () => {
    const agentId = await startAgent();
    expect(connectors).toHaveLength(1);
    const reEmitted: string[] = [];
    cleanups.push(
      MakaioBus.on(AdapterSubjects.session.closed, (ctx) => {
        reEmitted.push(ctx.payload.agentId);
      }),
    );

    // `agent.session.closed` is emitted before the connector teardown and the
    // adapter's own handler evicts on it, so this stop provokes a reentrant
    // teardown of the very agent it is tearing down.
    await MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    // Let the fire-and-forget eviction the emission triggered run to completion.
    await new Promise((resolve) => setImmediate(resolve));

    expect(connectors[0]?.closeCount).toBe(1);
    // One *flight*, which is the property the join delivers and the connector
    // count alone cannot see.
    expect(agents[0]?.teardownCount).toBe(1);
    // And the entry was still present when the emission's handler ran, which is
    // what "entry removal behind the close" buys: with the removal in front of the
    // close the handler finds nothing and this re-emission never happens.
    expect(reEmitted).toEqual([agentId]);
  });

  it('still produces one close when the reentrant eviction arrives mid-teardown', async () => {
    const agentId = await startAgent();
    const closeGate = new DeferredPromise<void>();
    const connector = connectors[0];
    if (connector === undefined) throw new Error('the start built no connector');
    connector.closeGate = closeGate.getPromise();

    const stop = MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId });
    // The close is held open, so the emission's handler provably reaches the
    // registry while the first teardown is still inside its close.
    await new Promise((resolve) => setImmediate(resolve));
    closeGate.resolve();
    await stop;
    await new Promise((resolve) => setImmediate(resolve));

    expect(connector.closeCount).toBe(1);
    expect(agents[0]?.teardownCount).toBe(1);
  });
});

describe('case 207: the `stopAgent` answer carries evidence beside its unchanged `success`', () => {
  it('reports the class the connector observed for a live agent', async () => {
    const agentId = await startAgent();
    const connector = connectors[0];
    if (connector === undefined) throw new Error('the start built no connector');
    connector.closeOutcome = { evidence: 'exited' };

    const response = await MakaioBus.request(AdapterSubjects.stopAgent, {
      adapterId: adapter.adapterId,
      agentId,
    });

    expect(response).toMatchObject({ success: true, evidence: 'exited' });
  });

  it('reports `{ success: false, evidence: released }` for an unknown agent', async () => {
    // The equivalence consumers depend on: "it is gone" answers the same question
    // as "it closed cleanly".
    const response = await MakaioBus.request(AdapterSubjects.stopAgent, {
      adapterId: adapter.adapterId,
      agentId: 'never-started',
    });

    expect(response).toEqual({ success: false, evidence: 'released' });
  });

  it('keeps `success: true` while reporting a weak class', async () => {
    const agentId = await startAgent();
    const connector = connectors[0];
    if (connector === undefined) throw new Error('the start built no connector');
    connector.closeOutcome = { evidence: 'detached', detail: 'supervisor outlives us' };

    const response = await MakaioBus.request(AdapterSubjects.stopAgent, {
      adapterId: adapter.adapterId,
      agentId,
    });

    // `success` still answers "was it there", which is what every existing caller
    // reads it as; what narrowed is that `true` no longer implies closure.
    expect(response).toMatchObject({ success: true, evidence: 'detached', detail: 'supervisor outlives us' });
  });

  it('reports `unknown` for a close that throws, and still answers', async () => {
    const agentId = await startAgent();
    const connector = connectors[0];
    if (connector === undefined) throw new Error('the start built no connector');
    connector.closeOutcome = new Error('connector close refused');

    const response = await MakaioBus.request(AdapterSubjects.stopAgent, {
      adapterId: adapter.adapterId,
      agentId,
    });

    // A stop whose teardown threw is still a stop that happened, and the caller
    // learns both facts: the agent was there, and nothing is known about its
    // resources. Asserted on the resolved response rather than on a rejection,
    // because the conversion is what §4 specifies and a rejecting handler would
    // leave every caller with an exception where a class belongs.
    expect(response).toMatchObject({ success: true, evidence: 'unknown' });
    expect(response.detail).toContain('connector close refused');
  });
});
