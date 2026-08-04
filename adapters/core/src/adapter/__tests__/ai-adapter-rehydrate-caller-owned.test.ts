/**
 * AIAdapter tests — `rehydrateAgent`'s caller-owned row and disposition union.
 *
 * Two contract changes are pinned here (#1140 Wave 3, cases 64 and 99):
 *
 * - `callerOwnsAgentRow` suppresses the adapter's `agent.updateStatus` write on
 *   both the cold and the warm path, and nothing else. The connector is still
 *   registered and the runtime is still published, because a caller that owns
 *   the row owns the `starting → idle` transition only — not the rehydrate.
 * - The response is a disposition union. A refusal the adapter takes before
 *   anything reaches the provider is modeled as `dispatch: 'not-dispatched'`,
 *   and a caller that joins an in-flight rehydrate is answered with the owning
 *   attempt's own result rather than a synthesised success.
 *
 * Case 99's adapter half — the warm-path claim denial as a modeled refusal —
 * is asserted in `ai-adapter-rehydrate-resume.test.ts`, next to the cold-path
 * denial it mirrors. Its service half (the token-scoped `released`) belongs to
 * the reserved-rehydrate consumer and is asserted there.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';
import type { ExtractSubjectResponse } from '@makaio/core';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import {
  createTestAdapter,
  MockConnector,
  type BaseAgentConnectorConfig,
  type TestAdapter,
  type TestBus,
} from './shared.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

/** The rehydrate disposition union, as callers on the bus observe it. */
type RehydrateAgentResponse = ExtractSubjectResponse<typeof AdapterSubjects.rehydrateAgent>;

const TEST_PROVIDER_CONTEXT = createNoAuthTestProviderContext('test-config', 'provider-1');
const ADAPTER_NAME = 'test-adapter-rehydrate-caller-owned';

/**
 * A connector whose provider session is its own, so every replacement is a real
 * provider-session movement rather than a re-confirmation of the same key.
 */
class MovingSessionConnector extends MockConnector {
  public constructor(
    config: BaseAgentConnectorConfig<TestBus> & { adapterId: string },
    private readonly confirmedAdapterSessionId: string,
  ) {
    super(config);
  }

  public override async getAdapterSessionId(): Promise<string> {
    return this.confirmedAdapterSessionId;
  }

  /** The synchronous accessor a swap publishes from. @returns This connector's session */
  public override getConfirmedAdapterSessionId(): string {
    return this.confirmedAdapterSessionId;
  }
}

describe('AIAdapter.handleRehydrateAgent - caller-owned row and disposition union', () => {
  let adapter: TestAdapter;
  let cleanupFns: Array<() => void> = [];
  let statusWrites: Array<{ agentId: string; status: string }>;
  let runtimeWrites: Array<{ agentId: string; adapterSessionId: string | undefined }>;
  let agentReads: number;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    cleanupFns = [];
    statusWrites = [];
    runtimeWrites = [];
    agentReads = 0;

    ({ adapter } = createTestAdapter(ADAPTER_NAME));
    await adapter.init();

    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.updateStatus, (ctx) => {
        statusWrites.push({ agentId: ctx.payload.agentId, status: ctx.payload.status });
        ctx.setResult({ success: true, transitioned: true });
      }),
      MakaioBus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
        runtimeWrites.push({ agentId: ctx.payload.agentId, adapterSessionId: ctx.payload.adapterSessionId });
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        ctx.setResult({ success: true });
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
   * Answer `agent.get` with a persisted, rehydratable agent row.
   * @param agentStatus - Status the persisted row reports
   * @param onGet - Optional hook awaited before the row is answered, to open a race window
   */
  function registerPersistedAgent(agentStatus: 'dead' | 'disposed', onGet?: () => Promise<void>): void {
    cleanupFns.push(
      MakaioBus.on(AgentStorageSubjects.get, async (ctx) => {
        agentReads += 1;
        if (onGet) await onGet();
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            adapterId: adapter.adapterId,
            adapterName: ADAPTER_NAME,
            sessionId: 'persisted-session',
            adapterSessionId: 'persisted-provider-session',
            role: 'lead' as const,
            status: agentStatus,
            model: 'persisted-model',
            cwd: os.tmpdir(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        });
      }),
    );
  }

  describe('cold path', () => {
    it('writes no status, still registers and publishes, and returns the confirmed provider session', async () => {
      registerPersistedAgent('dead');

      const result = await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'cold-caller-owned',
        // Deliberately not the ID the connector will confirm: a settling caller
        // must be told where the connector actually landed, not what it asked for.
        resumeAdapterSessionId: 'requested-provider-session',
        callerOwnsAgentRow: true,
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected the rehydrate to succeed');
      expect(result.adapterSessionId).toBe('mock-adapter-session-id');
      // The row's status belongs to the caller.
      expect(statusWrites).toEqual([]);
      // Everything else the rehydrate owns still happened.
      expect(adapter.getAgent('cold-caller-owned')).toBeDefined();
      // **And the confirmed key is returned, not published.** The row's
      // `adapterSessionId` is what a resume reads while no settled currency
      // exists, so writing it here would advertise a provider session no
      // generation holds — before the caller that reserved it has settled.
      expect(runtimeWrites).toEqual([]);
    });

    it('writes idle exactly as before when the flag is absent', async () => {
      registerPersistedAgent('dead');

      const result = await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'cold-adapter-owned',
      });

      expect(result.success).toBe(true);
      expect(statusWrites).toEqual([{ agentId: 'cold-adapter-owned', status: 'idle' }]);
    });

    it('announces the moved provider session only when it is not the caller who settles it', async () => {
      // One movement, one settle producer. A caller that owns the row reserved
      // this provider session and settles the confirmed key itself, under a
      // generation token it minted before dispatching; the observer behind this
      // announcement would settle the same movement under a token of its own,
      // which no failure path of that caller can name — so a caller whose
      // settlement then fails gives back everything it took and leaves that
      // generation held on a row it has just marked dead.
      registerPersistedAgent('dead');
      const announced: string[] = [];
      cleanupFns.push(
        MakaioBus.on(AgentSubjects.adapterSession.moved, (ctx) => {
          announced.push(ctx.payload.agentId);
        }),
      );

      await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'cold-caller-settles',
        resumeAdapterSessionId: 'requested-provider-session',
        callerOwnsAgentRow: true,
      });

      // The connector landed on a session the persisted row does not name, so
      // this is exactly the movement that would have been announced.
      expect(announced).toEqual([]);
      // And the identity is still *taken*: the registry resolves occupancy
      // through the agent's own current session, so a concurrent attach must
      // find this agent driving the session the caller is about to settle.
      expect(adapter.getAgent('cold-caller-settles')?.agent.currentAdapterSessionId).toBe('mock-adapter-session-id');
      // Neither announced nor written: the caller publishes this key, in both
      // forms, once its settlement has claimed it.
      expect(runtimeWrites).toEqual([]);

      // The adapter-owned twin: nobody else settles it, so the seam must — and
      // the same adapter writes the moved identity onto the row it owns.
      await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'cold-seam-settles',
      });
      expect(announced).toEqual(['cold-seam-settles']);
      expect(runtimeWrites).toEqual([{ agentId: 'cold-seam-settles', adapterSessionId: 'mock-adapter-session-id' }]);
    });

    it('refuses a disposed agent as not-dispatched instead of throwing', async () => {
      registerPersistedAgent('disposed');

      const result = await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId: 'cold-disposed',
        callerOwnsAgentRow: true,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected the rehydrate to be refused');
      expect(result.dispatch).toBe('not-dispatched');
      expect(result.message).toContain('disposed');
      // A refusal is not a rehydrate: nothing was registered, nothing written.
      expect(adapter.getAgent('cold-disposed')).toBeUndefined();
      expect(statusWrites).toEqual([]);
    });
  });

  describe('warm path', () => {
    /**
     * Start a live agent so the rehydrate takes the registered-agent path.
     * @param sessionId - Session the agent is started in
     * @returns The started agent's ID
     */
    async function startLiveAgent(sessionId: string): Promise<string> {
      const started = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: adapter.adapterId,
        role: 'lead' as const,
        sessionId,
        model: 'test-model',
        cwd: os.tmpdir(),
        providerContext: TEST_PROVIDER_CONTEXT,
      });
      expect(started.success).toBe(true);
      if (!started.success) throw new Error('Failed to start the live agent');
      return started.agentId;
    }

    it('writes no status when the caller owns the row, and idle when it does not', async () => {
      const agentId = await startLiveAgent('warm-caller-owned-session');
      statusWrites = [];

      const owned = await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId,
        model: 'override-model',
        callerOwnsAgentRow: true,
      });

      expect(owned.success).toBe(true);
      if (!owned.success) throw new Error('Expected the warm rehydrate to succeed');
      expect(owned.adapterSessionId).toBe('mock-adapter-session-id');
      expect(statusWrites).toEqual([]);
      // The connector swap itself is untouched by the flag.
      expect(runtimeWrites.some((write) => write.agentId === agentId)).toBe(true);

      const unowned = await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId: adapter.adapterId,
        agentId,
        model: 'override-model-2',
      });

      expect(unowned.success).toBe(true);
      expect(statusWrites).toEqual([{ agentId, status: 'idle' }]);
    });

    it('records the swapped-in session without announcing it when the caller settles', async () => {
      // The same rule as the cold path, and it needs saying twice because the
      // two paths produce their movement in different places: here it is
      // `swapConnector` that publishes the replacement's confirmed session
      // through the tracker, deep inside the dispatch — so a caller-owned warm
      // rehydrate announced its movement and had the observer settle the key
      // under a token the settling caller could never name.
      let connectors = 0;
      const { adapter: swapping } = createTestAdapter('test-adapter-warm-movement', {
        // A provider that mints a fresh session per connector, which is what
        // makes each swap an actual movement rather than a re-confirmation.
        connectorFactory: (config) => new MovingSessionConnector(config, `warm-session-${(connectors += 1)}`),
      });
      await swapping.init();
      const announced: string[] = [];
      /** What the agent answered while each movement was being announced. */
      const liveDuringAnnouncement: Array<string | undefined> = [];
      cleanupFns.push(
        MakaioBus.on(AgentSubjects.adapterSession.moved, async (ctx) => {
          announced.push(`${ctx.payload.agentId}:${ctx.payload.adapterSessionId ?? 'none'}`);
          liveDuringAnnouncement.push(await swapping.getAgent(ctx.payload.agentId)?.agent.getAdapterSessionId());
        }),
      );

      try {
        const started = await MakaioBus.request(AdapterSubjects.startAgent, {
          adapterId: swapping.adapterId,
          role: 'lead' as const,
          sessionId: 'warm-movement-session',
          model: 'test-model',
          cwd: os.tmpdir(),
          providerContext: TEST_PROVIDER_CONTEXT,
        });
        if (!started.success) throw new Error('Failed to start the live agent');
        announced.length = 0;
        liveDuringAnnouncement.length = 0;

        const owned = await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
          adapterId: swapping.adapterId,
          agentId: started.agentId,
          model: 'override-model',
          callerOwnsAgentRow: true,
        });

        // The swap really moved the identity — this is the movement that would
        // have been announced — and the caller is told where to settle.
        expect(owned.success).toBe(true);
        if (!owned.success) throw new Error('Expected the warm rehydrate to succeed');
        expect(owned.adapterSessionId).toBe('warm-session-2');
        expect(announced).toEqual([]);
        // Nor written onto the row: the swapped-in key is the caller's to
        // publish, and it publishes after its settlement claims it. The runtime
        // write still lands for the fields this rehydrate does own.
        expect(runtimeWrites.filter((write) => write.agentId === started.agentId)).toEqual([
          { agentId: started.agentId, adapterSessionId: undefined },
        ]);

        // The adapter-owned twin: nobody else settles it, so the seam must.
        const unowned = await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
          adapterId: swapping.adapterId,
          agentId: started.agentId,
          model: 'override-model-2',
        });
        expect(unowned.success).toBe(true);
        expect(announced).toEqual([`${started.agentId}:warm-session-3`]);
        // **The currency is written before the replacement is reachable.** The
        // announcement is awaited so the movement is ordered ahead of whatever
        // depends on it, and what depends on it here is the connector a
        // concurrent resume can reach: while the movement is in flight the
        // agent still answers with the predecessor, and the swapped-in
        // connector becomes reachable once the session row names its provider
        // session.
        expect(liveDuringAnnouncement).toEqual(['warm-session-2']);
        // The adapter-owned twin publishes both ways, as it always has.
        expect(runtimeWrites.filter((write) => write.agentId === started.agentId)).toEqual([
          { agentId: started.agentId, adapterSessionId: undefined },
          { agentId: started.agentId, adapterSessionId: 'warm-session-3' },
        ]);
      } finally {
        await swapping.closeAsync();
      }
    });
  });

  describe('single-flight join', () => {
    /**
     * Drive one rehydrate that a second caller joins while it is suspended.
     *
     * The owning attempt is held open inside its first storage read, which is
     * before the work either outcome depends on, so the joiner is guaranteed to
     * find the in-flight entry rather than start a second attempt.
     * @param agentId - Agent both callers rehydrate
     * @param agentStatus - Status the persisted row reports, which decides the owning attempt's outcome
     * @returns The owning attempt's response and the joiner's response
     */
    async function rehydrateWithJoiner(
      agentId: string,
      agentStatus: 'dead' | 'disposed',
    ): Promise<[RehydrateAgentResponse, RehydrateAgentResponse]> {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      let firstRead = true;
      registerPersistedAgent(agentStatus, async () => {
        if (!firstRead) return;
        firstRead = false;
        markEntered();
        await gate;
      });

      const owning = MakaioBus.request(AdapterSubjects.rehydrateAgent, { adapterId: adapter.adapterId, agentId });
      await entered;
      const joining = MakaioBus.request(AdapterSubjects.rehydrateAgent, { adapterId: adapter.adapterId, agentId });
      release();

      return Promise.all([owning, joining]);
    }

    it('answers a joining caller with the owning attempt refusal, not a synthesised success', async () => {
      const [owningResult, joiningResult] = await rehydrateWithJoiner('joined-refused-agent', 'disposed');

      // Asserted, not assumed: one storage read means the second caller really
      // joined instead of running an identical attempt of its own.
      expect(agentReads).toBe(1);
      // The joiner ran none of the work, so it must be told what the owning
      // attempt actually decided — under the old empty response it would have
      // read a refusal as a completed rehydrate.
      expect(joiningResult).toEqual(owningResult);
      expect(joiningResult.success).toBe(false);
      if (joiningResult.success) throw new Error('Expected the joined attempt to be refused');
      expect(joiningResult.dispatch).toBe('not-dispatched');
    });

    it('answers a joining caller with the owning attempt success and its confirmed session', async () => {
      const [owningResult, joiningResult] = await rehydrateWithJoiner('joined-live-agent', 'dead');

      expect(agentReads).toBe(1);
      expect(joiningResult).toEqual(owningResult);
      expect(joiningResult.success).toBe(true);
      if (!joiningResult.success) throw new Error('Expected the joined attempt to succeed');
      expect(joiningResult.adapterSessionId).toBe('mock-adapter-session-id');
    });
  });
});
