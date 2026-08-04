/**
 * Conformance suite: session ownership claims — two-connection race.
 *
 * Verifies that concurrent ownership operations from two genuinely independent
 * database handles (simulating separate processes) produce exactly the modeled
 * outcomes: one winner, one loser, no partial writes, no unhandled rejections.
 *
 * The in-process transaction queue (`executeTransaction`) serializes calls on
 * a single handle. Cross-handle exclusivity comes exclusively from the claim
 * table's unique index on `(machine_id, adapter_id, provider_session_id)`, which
 * is what this suite exercises.
 *
 * The second handle is genuinely independent on Postgres only. SQLite's driver
 * is synchronous, so a second connection blocking at `BEGIN` also blocks the
 * thread the first one needs in order to commit — two in-process connections
 * cannot race a SQLite file, they deadlock on it. On SQLite the second bus
 * therefore shares the primary handle: the requests still race, and the winner
 * is still decided by the unique index rather than by the in-process queue.
 *
 * Suites are discovered by filename; no index registration is required.
 */
import { afterAll, beforeAll, it, expect } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusInstance } from '@makaio/bus-core';
import { SessionOwnershipStorageSubjects } from '@makaio/contracts';
import {
  registerDrizzleSessionStorage,
  registerDrizzleAgentStorage,
  registerDrizzleSessionOwnershipStorage,
  SessionStorageSubjects,
  AgentStorageSubjects,
} from '@makaio/services-core/session';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import type { SiblingClient } from '../harness/config.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('session-ownership-claims', (config) => {
  // The race assertions model READ COMMITTED semantics (see the sibling-client
  // note below), and the primary client is the other half of every race — so
  // the isolation level is pinned on both rather than letting either inherit
  // the server's default_transaction_isolation.
  const getCtx = useSuiteDatabaseContext(config, {
    postgresSettings: { default_transaction_isolation: 'read committed' },
  });

  // ── Per-suite state ──────────────────────────────────────────────────────

  /**
   * Primary bus wired to `ctx.db` — used for setup (sessions, agents) and
   * one side of each race.
   */
  let busA: IMakaioBus;

  /**
   * Secondary bus racing `busA` on the ownership subjects only. Sessions and
   * agents it references are created through `busA` and are visible to it
   * because both buses address the same database/schema.
   */
  let busB: IMakaioBus;

  /**
   * Independent database client over the same isolated database/schema.
   *
   * Postgres only — see the module note on why SQLite cannot race two
   * in-process connections.
   */
  let sibling: SiblingClient | undefined;

  let cleanupA: Array<() => void> = [];
  let cleanupB: Array<() => void> = [];

  beforeAll(async () => {
    const ctx = getCtx();
    sibling =
      config.dialect === 'postgres'
        ? // The race assertions model the revision-CAS loser as `currency-changed`,
          // which is READ COMMITTED semantics (the guarded UPDATE re-evaluates its
          // predicate against the winner's committed row). Under REPEATABLE READ
          // Postgres raises `could not serialize access due to concurrent update`
          // (SQLSTATE 40001) instead, so the isolation level is pinned rather than
          // inherited from the server's default_transaction_isolation.
          await ctx.createSiblingClient({ postgresSettings: { default_transaction_isolation: 'read committed' } })
        : undefined;

    busA = createBusInstance();
    busB = createBusInstance();

    // busA gets session, agent and ownership handlers so it can also set up fixtures.
    cleanupA = [
      registerDrizzleSessionStorage(busA, ctx.db),
      registerDrizzleAgentStorage(busA, ctx.db),
      registerDrizzleSessionOwnershipStorage(busA, ctx.db),
    ];

    // busB only needs the ownership handler — fixture data written through
    // busA (ctx.db) is visible here because both buses address the same store.
    cleanupB = [registerDrizzleSessionOwnershipStorage(busB, sibling?.db ?? ctx.db)];
  });

  afterAll(async () => {
    for (let i = cleanupB.length - 1; i >= 0; i--) {
      cleanupB[i]?.();
    }
    for (let i = cleanupA.length - 1; i >= 0; i--) {
      cleanupA[i]?.();
    }
    await sibling?.close();
  });

  // ── Fixture helper ───────────────────────────────────────────────────────

  /**
   * Create a session and a member agent in the shared database via `busA`.
   * Both records are immediately visible to `busB` because it opens the same
   * underlying database file / schema.
   * @returns IDs of the created session and agent.
   */
  async function seedFixtures(): Promise<{ sessionId: string; agentId: string }> {
    const sessionId = `session-race-${crypto.randomUUID()}`;
    const agentId = `agent-race-${crypto.randomUUID()}`;
    const now = Date.now();

    await busA.request(SessionStorageSubjects.set, {
      sessionId,
      session: {
        sessionId,
        createdAt: now,
        lastActivityAt: now,
        agents: [],
        status: 'active' as const,
        isOrchestrated: false,
        isImported: false,
        currentAdapterSessionIdState: 'inherited' as const,
      },
    });

    await busA.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: `adapter-race-${crypto.randomUUID()}`,
        adapterName: 'race-adapter',
        sessionId,
        role: 'member' as const,
        status: 'idle' as const,
        createdAt: now,
        lastActivityAt: now,
        currentAdapterSessionIdState: 'inherited' as const,
        revision: 0,
        currencyFence: 0,
      },
    });

    return { sessionId, agentId };
  }

  /**
   * Build a base claim request object for the given agent and ownership key.
   * @param agentId - Agent to claim for.
   * @param sessionId - Session the agent belongs to.
   * @param machineId - Machine identity string.
   * @param adapterId - Adapter identity string.
   * @param providerSessionId - Provider session identity string.
   */
  function baseClaimRequest(
    agentId: string,
    sessionId: string,
    machineId: string,
    adapterId: string,
    providerSessionId: string,
  ) {
    return {
      machineId,
      adapterId,
      adapterName: 'race-adapter',
      providerSessionId,
      sessionId,
      agentId,
    } as const;
  }

  // ── Case 1: concurrent initial claims ────────────────────────────────────

  it('two concurrent initial claims: exactly one claimed, one already-claimed, and exactly one row', async () => {
    const { sessionId, agentId } = await seedFixtures();
    const machineId = `machine-race-${crypto.randomUUID()}`;
    const adapterId = `adapter-race-${crypto.randomUUID()}`;
    const providerSessionId = `prov-race-${crypto.randomUUID()}`;

    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    const base = baseClaimRequest(agentId, sessionId, machineId, adapterId, providerSessionId);

    // Fire both claims in the same tick — no awaited yield between them.
    const [resultA, resultB] = await Promise.all([
      busA.request(SessionOwnershipStorageSubjects.claim, { ...base, claimToken: tokenA }),
      busB.request(SessionOwnershipStorageSubjects.claim, { ...base, claimToken: tokenB }),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    // Exactly one winner, exactly one loser.
    expect(outcomes).toEqual(['already-claimed', 'claimed']);

    // Exactly one row in the claims table for this key.
    const listed = await busA.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId,
      adapterId,
      providerSessionId,
    });
    expect(listed.claims).toHaveLength(1);

    // The loser was told about the row that actually survived — not about some
    // intermediate state it happened to read.
    const loser = resultA.outcome === 'already-claimed' ? resultA : resultB;
    if (loser.outcome !== 'already-claimed') return;
    expect(loser.holder.claimToken).toBe(listed.claims[0]!.claimToken);
    expect(loser.holder.fence).toBe(listed.claims[0]!.fence);
  });

  // ── Case 2: concurrent takeovers of the same token ───────────────────────

  it('two concurrent takeovers of the same token: one claimed, one already-claimed, one row, fence = prev + 1', async () => {
    const { sessionId, agentId } = await seedFixtures();
    const machineId = `machine-takeover-${crypto.randomUUID()}`;
    const adapterId = `adapter-takeover-${crypto.randomUUID()}`;
    const providerSessionId = `prov-takeover-${crypto.randomUUID()}`;

    const initialToken = crypto.randomUUID();
    const base = baseClaimRequest(agentId, sessionId, machineId, adapterId, providerSessionId);

    // Establish an initial claim to take over.
    const initialResult = await busA.request(SessionOwnershipStorageSubjects.claim, {
      ...base,
      claimToken: initialToken,
    });
    expect(initialResult.outcome).toBe('claimed');
    if (initialResult.outcome !== 'claimed') return;
    const previousFence = initialResult.claim.fence;

    const takeoverTokenA = crypto.randomUUID();
    const takeoverTokenB = crypto.randomUUID();

    // Both handle processes attempt a takeover of the same initial generation simultaneously.
    const [takeoverA, takeoverB] = await Promise.all([
      busA.request(SessionOwnershipStorageSubjects.claim, {
        ...base,
        claimToken: takeoverTokenA,
        supersedes: { claimToken: initialToken },
      }),
      busB.request(SessionOwnershipStorageSubjects.claim, {
        ...base,
        claimToken: takeoverTokenB,
        supersedes: { claimToken: initialToken },
      }),
    ]);

    const outcomes = [takeoverA.outcome, takeoverB.outcome].sort();
    expect(outcomes).toEqual(['already-claimed', 'claimed']);

    // Exactly one row.
    const listed = await busA.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId,
      adapterId,
      providerSessionId,
    });
    expect(listed.claims).toHaveLength(1);

    // The surviving fence must be exactly previous + 1 (not +2, not any larger jump).
    expect(listed.claims[0]!.fence).toBe(previousFence + 1);

    // And the loser was told about that surviving generation.
    const loser = takeoverA.outcome === 'already-claimed' ? takeoverA : takeoverB;
    if (loser.outcome !== 'already-claimed') return;
    expect(loser.holder.claimToken).toBe(listed.claims[0]!.claimToken);
    expect(loser.holder.fence).toBe(listed.claims[0]!.fence);
  });

  // ── Case 3: concurrent claims on distinct keys for one agent ─────────────

  it('two concurrent claims on distinct keys for the same agent: fences are distinct and strictly ordered', async () => {
    const { sessionId, agentId } = await seedFixtures();
    const machineId = `machine-fence-${crypto.randomUUID()}`;
    const adapterId = `adapter-fence-${crypto.randomUUID()}`;

    // Two *different* ownership keys, so neither the owner index nor the token
    // index has anything to say: the only thing that can keep the two fences
    // apart is the per-agent allocation being serialized. A fence is ordered per
    // agent, and equal fences would let a settle from either generation pass the
    // other's guard.
    const keyA = `prov-fence-a-${crypto.randomUUID()}`;
    const keyB = `prov-fence-b-${crypto.randomUUID()}`;

    const [claimA, claimB] = await Promise.all([
      busA.request(SessionOwnershipStorageSubjects.claim, {
        ...baseClaimRequest(agentId, sessionId, machineId, adapterId, keyA),
        claimToken: crypto.randomUUID(),
      }),
      busB.request(SessionOwnershipStorageSubjects.claim, {
        ...baseClaimRequest(agentId, sessionId, machineId, adapterId, keyB),
        claimToken: crypto.randomUUID(),
      }),
    ]);

    // Distinct keys: both claims are legitimate — this is the state a movement
    // passes through between claim-new and release-old.
    expect(claimA.outcome).toBe('claimed');
    expect(claimB.outcome).toBe('claimed');
    if (claimA.outcome !== 'claimed' || claimB.outcome !== 'claimed') return;

    expect(claimA.claim.fence).not.toBe(claimB.claim.fence);

    // Strictly ordered, and allocated one after the other rather than both from
    // the same starting point.
    const fences = [claimA.claim.fence, claimB.claim.fence].sort((left, right) => left - right);
    expect(fences[1]).toBe(fences[0]! + 1);

    // The stored rows agree — the assertions above must not rest on what the
    // handlers reported back.
    const listed = await busA.request(SessionOwnershipStorageSubjects.listClaims, { machineId, adapterId });
    expect(listed.claims).toHaveLength(2);
    expect(new Set(listed.claims.map((claim) => claim.fence)).size).toBe(2);
  });

  // ── Case 4: concurrent settles from the same expectedRevision ─────────────

  it("two concurrent settles from the same expectedRevision: one settled, one currency-changed, stored currency is the winner's", async () => {
    const { sessionId, agentId } = await seedFixtures();
    const machineId = `machine-settle-${crypto.randomUUID()}`;
    const adapterId = `adapter-settle-${crypto.randomUUID()}`;
    const providerSessionId = `prov-settle-${crypto.randomUUID()}`;

    const claimToken = crypto.randomUUID();
    const base = baseClaimRequest(agentId, sessionId, machineId, adapterId, providerSessionId);

    // Establish a claim through busA (any handle will do for setup).
    const claimResult = await busA.request(SessionOwnershipStorageSubjects.claim, {
      ...base,
      claimToken,
    });
    expect(claimResult.outcome).toBe('claimed');
    if (claimResult.outcome !== 'claimed') return;
    const fence = claimResult.claim.fence;

    // Both processes settle from revision=0 simultaneously, with different targets.
    const [settleA, settleB] = await Promise.all([
      busA.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'session-winner-A',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      }),
      busB.request(SessionOwnershipStorageSubjects.settleCurrency, {
        agentId,
        claimToken,
        fence,
        expectedRevision: 0,
        target: {
          currentAdapterSessionId: 'session-winner-B',
          currentAdapterSessionIdState: 'confirmed' as const,
        },
      }),
    ]);

    const outcomes = [settleA.outcome, settleB.outcome].sort();
    expect(outcomes).toEqual(['currency-changed', 'settled']);

    // Identify winner and loser.
    const winner = settleA.outcome === 'settled' ? settleA : settleB;
    const loser = settleA.outcome === 'currency-changed' ? settleA : settleB;

    if (winner.outcome !== 'settled') return;
    if (loser.outcome !== 'currency-changed') return;

    // Anchored to the literal target of whichever call reported `settled`, not
    // to what that call reported back: a handler echoing its own request would
    // otherwise satisfy every assertion below without having written anything.
    const winnerCurrencyId = settleA.outcome === 'settled' ? 'session-winner-A' : 'session-winner-B';
    expect(winner.currency.currentAdapterSessionId).toBe(winnerCurrencyId);

    // The loser's currency report must echo the winner's committed value.
    expect(loser.currency.currentAdapterSessionId).toBe(winnerCurrencyId);

    // The stored state — read through the primary handle — must be the winner's.
    const readResult = await busA.request(SessionOwnershipStorageSubjects.read, { agentId });
    expect(readResult.ownership?.currency.currentAdapterSessionId).toBe(winnerCurrencyId);
    expect(readResult.ownership?.revision).toBe(winner.revision);
  });
});
