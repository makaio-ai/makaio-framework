/**
 * AIAdapter tests — caller-supplied agent identity.
 *
 * A caller that has already persisted the agent row supplies its `agentId`.
 * Doing so transfers the row: the adapter honours the identity and emits its
 * lifecycle events as usual, but writes no agent record of its own, because a
 * whole-record write would overwrite the lifecycle state the caller persisted
 * before dispatching. Two starts for one supplied identity are refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import {
  MockConnector,
  createTestAdapter,
  type BaseAgentConnectorConfig,
  type TestAdapter,
  type TestBus,
} from './shared.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

const TEST_PROVIDER_CONTEXT = createNoAuthTestProviderContext('test-config', 'provider-1');

/**
 * A connector that reports itself busy and then idle from inside `start`.
 *
 * What a real one does — an ACP provider emits its turn events while the start
 * call is still running — and what makes the agent emit an *enriched* event
 * before the start has returned anything to its caller.
 */
class EmittingDuringStartConnector extends MockConnector {
  public constructor(config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) {
    super(config);
  }

  public override async start(message: Parameters<MockConnector['start']>[0]) {
    const result = await super.start(message);
    // The provider confirmed the session inside the start, which is what makes
    // the event below carry a key at all.
    this.adapterSessionId = result.adapterSessionId;
    await this.reportProcessing();
    return result;
  }

  /** Drive the state the agent's wiring turns into an emitted event. */
  public async reportProcessing(): Promise<void> {
    await this.updateProcessingState('turn_started');
    await this.updateProcessingState('idle');
  }
}

describe('AIAdapter - caller-owned agent row', () => {
  let adapter: TestAdapter;
  let cleanupFns: Array<() => void> = [];
  let persistedAgentIds: string[];
  let addedAgentIds: string[];
  /** Every `session.agent.added` payload, for the fields the session row takes from it. */
  let added: Array<{ agentId: string; adapterSessionId: string | undefined; role: string | undefined }>;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
    persistedAgentIds = [];
    addedAgentIds = [];
    added = [];

    const result = createTestAdapter('test-caller-owned-adapter');
    adapter = result.adapter;
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        persistedAgentIds.push(ctx.payload.agentId);
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(SessionSubjects.agent.added, (ctx) => {
        addedAgentIds.push(ctx.payload.agentId);
        added.push({
          agentId: ctx.payload.agentId,
          adapterSessionId: ctx.payload.adapterSessionId,
          role: ctx.payload.role,
        });
      }),
    );
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await adapter?.closeAsync();
  });

  /**
   * Start an agent on the test adapter, optionally under a caller-supplied identity.
   * @param sessionId - Session to attach the agent to
   * @param agentId - Caller-minted agent identity, or `undefined` to let the adapter mint one
   * @returns The startAgent response
   */
  async function startAgent(
    sessionId: string,
    agentId?: string,
  ): Promise<Awaited<ReturnType<typeof MakaioBus.request<typeof AdapterSubjects.startAgent>>>> {
    return MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      sessionId,
      role: 'lead' as const,
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
      ...(agentId !== undefined && { agentId }),
    });
  }

  it('uses the supplied identity, persists no agent record, and still emits agent.added', async () => {
    const startResult = await startAgent('caller-owned-session-1', 'caller-minted-agent');

    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('startAgent failed unexpectedly');
    expect(startResult.agentId).toBe('caller-minted-agent');
    // The row belongs to the caller: no whole-record write from here.
    expect(persistedAgentIds).toEqual([]);
    // Lifecycle emission is unchanged — it is what says a live agent exists.
    expect(addedAgentIds).toEqual(['caller-minted-agent']);
    expect(adapter.getAgent('caller-minted-agent')).toBeDefined();
  });

  /**
   * Start an agent that carries an initial message, so the provider confirms a
   * session and there is an identity to publish or withhold.
   * @param sessionId - Session to attach the agent to
   * @param agentId - Caller-minted agent identity, or `undefined` to let the adapter mint one
   * @returns The startAgent response
   */
  async function startConfirmingAgent(
    sessionId: string,
    agentId?: string,
  ): Promise<Awaited<ReturnType<typeof MakaioBus.request<typeof AdapterSubjects.startAgent>>>> {
    return MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      sessionId,
      role: 'lead' as const,
      model: 'test-model',
      cwd: os.tmpdir(),
      initialMessage: 'hello',
      providerContext: TEST_PROVIDER_CONTEXT,
      ...(agentId !== undefined && { agentId }),
    });
  }

  it('publishes nothing about the provider key while the caller-owned start runs', async () => {
    // The third publication route: payload enrichment. Every event the agent
    // emits records the connector's identity and stamps it — which announces the
    // movement (the observer would settle the key under a token this start's
    // caller cannot give back) and hands the key to consumers that write it onto
    // rows. Inside a caller-owned start neither is this adapter's to do: the
    // caller reserved the provider session and settles what the connector
    // confirms, and the key travels back in the response.
    const announced: string[] = [];
    /** Keys stamped on events emitted **while the start was still running**. */
    const stampedDuringStart: Array<string | undefined> = [];
    /** Keys the two lifecycle events carried. */
    const lifecycleKeys: Array<string | undefined> = [];
    let startInFlight = true;
    cleanupFns.push(
      MakaioBus.on(AgentSubjects.adapterSession.moved, (ctx) => {
        announced.push(ctx.payload.agentId);
      }),
      MakaioBus.on(AgentSubjects.idle, (ctx) => {
        if (startInFlight) stampedDuringStart.push(ctx.payload.adapterSessionId);
      }),
      MakaioBus.on(SessionSubjects.agent.added, (ctx) => {
        lifecycleKeys.push(ctx.payload.adapterSessionId);
      }),
      MakaioBus.on(AdapterSubjects.session.created, (ctx) => {
        lifecycleKeys.push(ctx.payload.adapterSessionId);
      }),
    );

    let connector: EmittingDuringStartConnector | undefined;
    const { adapter: emitting } = createTestAdapter('test-caller-owned-emitting', {
      connectorFactory: (config) => {
        connector = new EmittingDuringStartConnector(config);
        return connector;
      },
    });
    await emitting.init();
    cleanupFns.push(() => void emitting.closeAsync());

    const owned = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: emitting.adapterId,
      sessionId: 'caller-owned-session-enriched',
      role: 'lead' as const,
      model: 'test-model',
      cwd: os.tmpdir(),
      initialMessage: 'hello',
      providerContext: TEST_PROVIDER_CONTEXT,
      agentId: 'caller-enriched-agent',
    });
    startInFlight = false;
    expect(owned.success).toBe(true);
    if (!owned.success) throw new Error('startAgent failed unexpectedly');
    // The connector confirmed a key inside the start, and an event carrying it
    // was emitted there — so there was something to publish and something to
    // publish it with.
    expect(owned.adapterSessionId).toBe('mock-adapter-session-id');
    expect(stampedDuringStart).toHaveLength(1);
    // Neither route published it. The stamp is withheld while the key is not
    // this adapter's to hand out, and the movement is never announced at all:
    // the start hands the key over as the caller's to settle, so the seam stays
    // silent about it afterwards too.
    expect(stampedDuringStart).toEqual([undefined]);
    expect(announced).toEqual([]);
    // The two lifecycle events are the same gate's routes — the tracking event
    // as much as the one the session service consumes: a key readable by anyone
    // subscribed is published, whatever the event is called.
    expect(lifecycleKeys).toEqual([undefined, undefined]);

    // And the key stays the caller's after the window closes: the start handed
    // it over rather than staying silent about it, so the first event enriched
    // once publication reopens does not announce it behind the settlement it
    // belongs to.
    await connector?.reportProcessing();
    expect(announced).toEqual([]);
  });

  it('withholds the provider session from a caller-owned start, and only that field', async () => {
    // The consumer writes this field onto the session row as its resume
    // identity, and this event lands *before* the caller's settlement claims the
    // key — so a concurrent attach could resolve it as resumable and reserve it
    // out from under the start that is still completing. The caller publishes it
    // after the claim, in both forms; the designation this event exists for
    // rides on `role`, which is untouched.
    // An initial message, because that is what makes the provider confirm a
    // session: an idle start reports none, and a field that is absent anyway
    // would prove nothing about withholding it.
    const owned = await startConfirmingAgent('caller-owned-session-published', 'caller-published-agent');
    expect(owned.success).toBe(true);
    if (!owned.success) throw new Error('startAgent failed unexpectedly');
    // Asserted, not assumed: the connector did confirm a key, so there was one
    // to withhold.
    expect(owned.adapterSessionId).toBe('mock-adapter-session-id');
    expect(added).toEqual([{ agentId: 'caller-published-agent', adapterSessionId: undefined, role: 'lead' }]);

    // The adapter-owned twin, where nobody else publishes it.
    const unowned = await startConfirmingAgent('adapter-owned-session-published');
    expect(unowned.success).toBe(true);
    if (!unowned.success) throw new Error('startAgent failed unexpectedly');
    expect(added[1]).toEqual({
      agentId: unowned.agentId,
      adapterSessionId: 'mock-adapter-session-id',
      role: 'lead',
    });
  });

  it('refuses a supplied identity that is already registered, before dispatching', async () => {
    const first = await startAgent('caller-owned-session-2', 'duplicate-agent');
    // Asserted, not assumed: a refusal on the second start proves nothing if
    // the first never registered the identity it is supposed to collide with.
    expect(first.success).toBe(true);
    const collision = await startAgent('caller-owned-session-2', 'duplicate-agent');

    expect(collision.success).toBe(false);
    if (collision.success) throw new Error('Expected the second start to be refused');
    expect(collision.dispatch).toBe('not-dispatched');
    expect(collision.message).toContain('duplicate-agent');
    // The first agent is untouched — a refusal must not replace a live connector.
    expect(adapter.getActiveAgents()).toHaveLength(1);
  });

  it('mints the identity and persists the agent record when no agentId is supplied', async () => {
    const startResult = await startAgent('caller-owned-session-3');

    expect(startResult.success).toBe(true);
    if (!startResult.success) throw new Error('startAgent failed unexpectedly');
    expect(persistedAgentIds).toEqual([startResult.agentId]);
    expect(addedAgentIds).toEqual([startResult.agentId]);
  });
});
