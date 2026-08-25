/**
 * Conformance suite: session ownership claims — multi-connection race.
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
import { afterAll, beforeAll, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusInstance } from '@makaio/bus-core';
import {
  SessionOwnershipStorageSubjects,
  type AdapterSessionClaimRecord,
  type SessionOwnershipSettleMovementResult,
} from '@makaio/contracts';
import {
  registerDrizzleSessionStorage,
  registerDrizzleAgentStorage,
  registerDrizzleSessionOwnershipStorage,
  ownershipClaimTransactionLock,
  SessionStorageSubjects,
  AgentStorageSubjects,
} from '@makaio/services-core/session';
import { acquireTransactionLocks, executeTransaction, getRawSqlExecutor } from '@makaio/storage-drizzle';
import { postgresTransactionLockKey } from '@makaio/storage-pg';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import type { SiblingClient } from '../harness/config.js';

/**
 * Read the claim row a *keyed* acquisition must have taken.
 *
 * The response's `claim` is nullable because a **keyless** reservation takes no
 * row at all — it designates a lead and nothing else. Every acquisition in this
 * suite names a provider session, so a null here is a broken contract rather
 * than a case to branch on, and failing loudly beats an optional chain that
 * quietly asserts nothing.
 * @param claim - The claim the response carried.
 * @returns The same claim, known to exist.
 */
function requireClaim(claim: AdapterSessionClaimRecord | null): AdapterSessionClaimRecord {
  if (claim === null) throw new Error('a keyed acquisition reported no claim row');
  return claim;
}

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

  /** Third ownership client for counter-allocation contention conformance. */
  let busC: IMakaioBus;

  /**
   * Independent database client over the same isolated database/schema.
   *
   * Postgres only — see the module note on why SQLite cannot race two
   * in-process connections.
   */
  let sibling: SiblingClient | undefined;

  /** A second independent sibling used only by the three-client Postgres cases. */
  let thirdSibling: SiblingClient | undefined;

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
    thirdSibling =
      config.dialect === 'postgres'
        ? await ctx.createSiblingClient({ postgresSettings: { default_transaction_isolation: 'read committed' } })
        : undefined;

    busA = createBusInstance();
    busB = createBusInstance();
    busC = createBusInstance();

    // busA gets session, agent and ownership handlers so it can also set up fixtures.
    cleanupA = [
      registerDrizzleSessionStorage(busA, ctx.db),
      registerDrizzleAgentStorage(busA, ctx.db),
      registerDrizzleSessionOwnershipStorage(busA, ctx.db),
    ];

    // busB only needs the ownership handler — fixture data written through
    // busA (ctx.db) is visible here because both buses address the same store.
    // The session handler joins busB for the claim-vs-delete race: the delete
    // has to run on the *other* connection for the lock orders to meet.
    cleanupB = [
      registerDrizzleSessionOwnershipStorage(busB, sibling?.db ?? ctx.db),
      registerDrizzleSessionStorage(busB, sibling?.db ?? ctx.db),
    ];
    cleanupB.push(registerDrizzleSessionOwnershipStorage(busC, thirdSibling?.db ?? ctx.db));
  });

  afterAll(async () => {
    for (let i = cleanupB.length - 1; i >= 0; i--) {
      cleanupB[i]?.();
    }
    for (let i = cleanupA.length - 1; i >= 0; i--) {
      cleanupA[i]?.();
    }
    await sibling?.close();
    await thirdSibling?.close();
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
   * @param ownerInstanceId - Runtime process taking the generation.
   */
  function baseClaimRequest(
    agentId: string,
    sessionId: string,
    machineId: string,
    adapterId: string,
    providerSessionId: string,
    ownerInstanceId: string,
  ) {
    return {
      machineId,
      adapterId,
      adapterName: 'race-adapter',
      providerSessionId,
      sessionId,
      agentId,
      ownerInstance: { instanceId: ownerInstanceId },
    } as const;
  }

  /**
   * Wait until the requested number of Postgres transactions are queued on one
   * advisory lock.
   *
   * This is a database-observed barrier, not a timing assumption: the claim
   * statement cannot proceed past the test trigger until its ungranted lock is
   * visible in `pg_locks`.
   * @param lockKey - Single-key advisory lock identity.
   * @param expected - Exact number of blocked claim transactions.
   */
  async function waitForAdvisoryWaiters(lockKey: number, expected: number): Promise<void> {
    const executor = getRawSqlExecutor(getCtx().db);
    await vi.waitFor(
      async () => {
        const rows = await executor.all<{ waiters: number }>(sql`
          SELECT count(*)::integer AS waiters
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = 0
            AND objid = ${lockKey}
            AND NOT granted
        `);
        expect(rows[0]?.waiters).toBe(expected);
      },
      { timeout: 5_000, interval: 10 },
    );
  }

  /**
   * Wait until one database backend is blocked by the named transaction.
   * @param blockerPid - Backend PID currently holding the stable-key lock.
   * @returns Backend PID waiting on that transaction.
   */
  async function waitForBackendBlockedBy(blockerPid: number): Promise<number> {
    const executor = getRawSqlExecutor(getCtx().db);
    let blockedPid: number | undefined;
    await vi.waitFor(
      async () => {
        const rows = await executor.all<{ pid: number }>(sql`
          SELECT pid
          FROM pg_stat_activity
          WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
        `);
        expect(rows).toHaveLength(1);
        blockedPid = rows[0]?.pid;
      },
      { timeout: 5_000, interval: 10 },
    );
    if (blockedPid === undefined) throw new Error('blocked backend disappeared before its PID was read');
    return blockedPid;
  }

  // ── Case 1: concurrent initial claims ────────────────────────────────────

  it('two concurrent initial claims: exactly one claimed, one already-claimed, and exactly one row', async () => {
    const { sessionId, agentId } = await seedFixtures();
    const machineId = `machine-race-${crypto.randomUUID()}`;
    const adapterId = `adapter-race-${crypto.randomUUID()}`;
    const providerSessionId = `prov-race-${crypto.randomUUID()}`;

    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    const baseA = baseClaimRequest(
      agentId,
      sessionId,
      machineId,
      adapterId,
      providerSessionId,
      `instance-race-a-${crypto.randomUUID()}`,
    );
    const baseB = baseClaimRequest(
      agentId,
      sessionId,
      machineId,
      adapterId,
      providerSessionId,
      `instance-race-b-${crypto.randomUUID()}`,
    );

    // Fire both claims in the same tick — no awaited yield between them.
    const [resultA, resultB] = await Promise.all([
      busA.request(SessionOwnershipStorageSubjects.claim, { ...baseA, claimToken: tokenA }),
      busB.request(SessionOwnershipStorageSubjects.claim, { ...baseB, claimToken: tokenB }),
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
    const initialOwnerInstanceId = `instance-takeover-initial-${crypto.randomUUID()}`;
    const base = baseClaimRequest(agentId, sessionId, machineId, adapterId, providerSessionId, initialOwnerInstanceId);

    // Establish an initial claim to take over.
    const initialResult = await busA.request(SessionOwnershipStorageSubjects.claim, {
      ...base,
      claimToken: initialToken,
    });
    expect(initialResult.outcome).toBe('claimed');
    if (initialResult.outcome !== 'claimed') return;
    const previousFence = requireClaim(initialResult.claim).fence;

    const takeoverTokenA = crypto.randomUUID();
    const takeoverTokenB = crypto.randomUUID();

    // Both handle processes attempt a takeover of the same initial generation simultaneously.
    const [takeoverA, takeoverB] = await Promise.all([
      busA.request(SessionOwnershipStorageSubjects.claim, {
        ...base,
        ownerInstance: { instanceId: `instance-takeover-a-${crypto.randomUUID()}` },
        claimToken: takeoverTokenA,
        supersedes: { claimToken: initialToken },
      }),
      busB.request(SessionOwnershipStorageSubjects.claim, {
        ...base,
        ownerInstance: { instanceId: `instance-takeover-b-${crypto.randomUUID()}` },
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
        ...baseClaimRequest(agentId, sessionId, machineId, adapterId, keyA, `instance-fence-${crypto.randomUUID()}`),
        claimToken: crypto.randomUUID(),
      }),
      busB.request(SessionOwnershipStorageSubjects.claim, {
        ...baseClaimRequest(agentId, sessionId, machineId, adapterId, keyB, `instance-fence-${crypto.randomUUID()}`),
        claimToken: crypto.randomUUID(),
      }),
    ]);

    // Distinct keys: both claims are legitimate — this is the state a movement
    // passes through between claim-new and release-old.
    expect(claimA.outcome).toBe('claimed');
    expect(claimB.outcome).toBe('claimed');
    if (claimA.outcome !== 'claimed' || claimB.outcome !== 'claimed') return;

    const fenceA = requireClaim(claimA.claim).fence;
    const fenceB = requireClaim(claimB.claim).fence;
    expect(fenceA).not.toBe(fenceB);

    // Strictly ordered, and allocated one after the other rather than both from
    // the same starting point.
    const fences = [fenceA, fenceB].sort((left, right) => left - right);
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
    const base = baseClaimRequest(
      agentId,
      sessionId,
      machineId,
      adapterId,
      providerSessionId,
      `instance-settle-${crypto.randomUUID()}`,
    );

    // Establish a claim through busA (any handle will do for setup).
    const claimResult = await busA.request(SessionOwnershipStorageSubjects.claim, {
      ...base,
      claimToken,
    });
    expect(claimResult.outcome).toBe('claimed');
    if (claimResult.outcome !== 'claimed') return;
    const fence = requireClaim(claimResult.claim).fence;

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

  // ── Case 5: concurrent movements onto one successor key ──────────────────

  it('two agents moving onto one successor key: one settled, one already-claimed, and the loser wrote nothing', async () => {
    const first = await seedFixtures();
    const second = await seedFixtures();
    const machineId = `machine-movement-${crypto.randomUUID()}`;
    const adapterId = `adapter-movement-${crypto.randomUUID()}`;
    const providerSessionId = `prov-movement-${crypto.randomUUID()}`;

    /**
     * Build a confirmed movement onto the contested key.
     * @param fixture - The agent and session moving onto it.
     * @returns The movement request.
     */
    const movementFor = (fixture: { sessionId: string; agentId: string }) => ({
      machineId,
      adapterId,
      adapterName: 'race-adapter',
      sessionId: fixture.sessionId,
      agentId: fixture.agentId,
      ownerInstance: { instanceId: `instance-movement-${fixture.agentId}` },
      expectedRevision: 0,
      movement: { kind: 'confirmed' as const, providerSessionId, claimToken: crypto.randomUUID() },
    });

    // The movement is one transaction — acquire, settle, retire, mirror — so a
    // loser must leave *nothing*: not a claim row, and not a settled currency.
    const [resultA, resultB] = await Promise.all([
      busA.request(SessionOwnershipStorageSubjects.settleMovement, movementFor(first)),
      busB.request(SessionOwnershipStorageSubjects.settleMovement, movementFor(second)),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(['already-claimed', 'settled']);

    const listed = await busA.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId,
      adapterId,
      providerSessionId,
    });
    expect(listed.claims).toHaveLength(1);

    const winnerAgentId = resultA.outcome === 'settled' ? first.agentId : second.agentId;
    const loserAgentId = resultA.outcome === 'settled' ? second.agentId : first.agentId;
    expect(listed.claims[0]!.agentId).toBe(winnerAgentId);

    // The loser was told about the row that actually survived …
    const loser = resultA.outcome === 'already-claimed' ? resultA : resultB;
    if (loser.outcome !== 'already-claimed') return;
    expect(loser.holder.claimToken).toBe(listed.claims[0]!.claimToken);

    // … and its own agent row is exactly as it was: the settle rolled back with
    // the acquisition it could not complete.
    const loserOwnership = await busA.request(SessionOwnershipStorageSubjects.read, { agentId: loserAgentId });
    expect(loserOwnership.ownership?.revision).toBe(0);
    expect(loserOwnership.ownership?.currencyFence).toBe(0);
    expect(loserOwnership.ownership?.currency.currentAdapterSessionIdState).toBe('inherited');
    expect(loserOwnership.ownership?.claims).toHaveLength(0);

    const winnerOwnership = await busA.request(SessionOwnershipStorageSubjects.read, { agentId: winnerAgentId });
    expect(winnerOwnership.ownership?.currency.currentAdapterSessionId).toBe(providerSessionId);
  });

  // ── R56: durable owner identity ─────────────────────────────────────────

  it('owner identity uses a RESTRICT composite FK while legacy null ownership remains representable', async () => {
    const { sessionId, agentId } = await seedFixtures();
    const machineId = `machine-owner-fk-${crypto.randomUUID()}`;
    const adapterId = `adapter-owner-fk-${crypto.randomUUID()}`;
    const providerSessionId = `prov-owner-fk-${crypto.randomUUID()}`;
    const ownerInstanceId = `instance-owner-fk-${crypto.randomUUID()}`;
    const claimToken = crypto.randomUUID();

    const claimed = await busA.request(SessionOwnershipStorageSubjects.claim, {
      ...baseClaimRequest(agentId, sessionId, machineId, adapterId, providerSessionId, ownerInstanceId),
      claimToken,
    });
    expect(claimed.outcome).toBe('claimed');
    if (claimed.outcome !== 'claimed') return;
    expect(requireClaim(claimed.claim).ownerInstanceId).toBe(ownerInstanceId);

    const executor = getRawSqlExecutor(getCtx().db);

    // The referenced runtime row cannot disappear while a generation names it.
    // This rejects both a cascading deletion and the impossible SET NULL shape
    // that would have to null only half of the composite identity.
    await expect(
      executor.run(sql`
        DELETE FROM runtime_instances
        WHERE instance_id = ${ownerInstanceId} AND machine_id = ${machineId}
      `),
    ).rejects.toThrow();

    const stillOwned = await busA.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId,
      adapterId,
      providerSessionId,
    });
    expect(stillOwned.claims).toHaveLength(1);
    expect(stillOwned.claims[0]?.ownerInstanceId).toBe(ownerInstanceId);

    // Existing databases may carry ownerless rows. A null owner-instance half
    // deliberately opts out of the composite reference while preserving the
    // non-null machine identity and the blocking claim itself.
    await executor.run(sql`
      UPDATE adapter_session_claims
      SET owner_instance_id = NULL
      WHERE claim_token = ${claimToken}
    `);
    await expect(
      executor.run(sql`
        DELETE FROM runtime_instances
        WHERE instance_id = ${ownerInstanceId} AND machine_id = ${machineId}
      `),
    ).resolves.toBeDefined();

    const legacy = await busA.request(SessionOwnershipStorageSubjects.listClaims, {
      machineId,
      adapterId,
      providerSessionId,
    });
    expect(legacy.claims).toHaveLength(1);
    expect(legacy.claims[0]?.ownerInstanceId).toBeNull();
    expect(legacy.claims[0]?.machineId).toBe(machineId);
  });

  // ── Runtime incarnation counter allocation ───────────────────────────────

  it('allocates three claim-owner incarnations through one Postgres counter row', async () => {
    if (config.dialect !== 'postgres' || sibling === undefined || thirdSibling === undefined) return;

    const first = await seedFixtures();
    const second = await seedFixtures();
    const third = await seedFixtures();
    const machineId = `machine-incarnation-${crypto.randomUUID()}`;
    const adapterId = `adapter-incarnation-${crypto.randomUUID()}`;
    const firstOwnerInstanceId = `instance-incarnation-a-${crypto.randomUUID()}`;
    const secondOwnerInstanceId = `instance-incarnation-b-${crypto.randomUUID()}`;
    const thirdOwnerInstanceId = `instance-incarnation-c-${crypto.randomUUID()}`;
    const lockKey = crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff;
    const functionName = `r57_incarnation_gate_${crypto.randomUUID().replaceAll('-', '_')}`;
    const triggerName = `r57_incarnation_gate_${crypto.randomUUID().replaceAll('-', '_')}`;
    const executor = getRawSqlExecutor(getCtx().db);

    // The trigger blocks the counter allocation itself. `pg_locks` observes all
    // three independent clients there before the gate opens, so this is neither
    // a timing assumption nor an in-process serialization test.
    await executor.run(
      sql.raw(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock_shared(${lockKey});
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `),
    );
    await executor.run(
      sql.raw(`
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON runtime_instance_incarnation_counters
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
      `),
    );

    const firstClaim = () =>
      busA.request(SessionOwnershipStorageSubjects.claim, {
        ...baseClaimRequest(
          first.agentId,
          first.sessionId,
          machineId,
          adapterId,
          `provider-incarnation-a-${crypto.randomUUID()}`,
          firstOwnerInstanceId,
        ),
        claimToken: crypto.randomUUID(),
      });
    const secondClaim = () =>
      busB.request(SessionOwnershipStorageSubjects.claim, {
        ...baseClaimRequest(
          second.agentId,
          second.sessionId,
          machineId,
          adapterId,
          `provider-incarnation-b-${crypto.randomUUID()}`,
          secondOwnerInstanceId,
        ),
        claimToken: crypto.randomUUID(),
      });
    const thirdClaim = () =>
      busC.request(SessionOwnershipStorageSubjects.claim, {
        ...baseClaimRequest(
          third.agentId,
          third.sessionId,
          machineId,
          adapterId,
          `provider-incarnation-c-${crypto.randomUUID()}`,
          thirdOwnerInstanceId,
        ),
        claimToken: crypto.randomUUID(),
      });

    try {
      const [resultA, resultB, resultC] = await executor.withSession(async (gate) => {
        await gate.run(sql`SELECT pg_advisory_lock(CAST(${String(lockKey)} AS bigint))`);
        let operationA: ReturnType<typeof firstClaim> | undefined;
        let operationB: ReturnType<typeof secondClaim> | undefined;
        let operationC: ReturnType<typeof thirdClaim> | undefined;
        let gateReleased = false;
        try {
          operationA = firstClaim();
          await waitForAdvisoryWaiters(lockKey, 1);
          operationB = secondClaim();
          await waitForAdvisoryWaiters(lockKey, 2);
          operationC = thirdClaim();
          await waitForAdvisoryWaiters(lockKey, 3);
        } catch (error) {
          await gate.run(sql`SELECT pg_advisory_unlock(CAST(${String(lockKey)} AS bigint))`);
          gateReleased = true;
          await Promise.allSettled([operationA, operationB, operationC].filter((item) => item !== undefined));
          throw error;
        } finally {
          // Release even if a barrier assertion fails, otherwise the pending
          // claim owns a checked-out connection and suite teardown cannot drop
          // the isolated schema.
          if (!gateReleased) await gate.run(sql`SELECT pg_advisory_unlock(CAST(${String(lockKey)} AS bigint))`);
        }

        if (operationA === undefined || operationB === undefined || operationC === undefined) {
          await Promise.allSettled([operationA, operationB, operationC].filter((item) => item !== undefined));
          throw new Error('counter allocation barrier failed before all claim operations entered');
        }
        return Promise.all([operationA, operationB, operationC]);
      });

      expect(resultA.outcome).toBe('claimed');
      expect(resultB.outcome).toBe('claimed');
      expect(resultC.outcome).toBe('claimed');
      if (resultA.outcome !== 'claimed' || resultB.outcome !== 'claimed' || resultC.outcome !== 'claimed') return;

      const instanceA = await busA.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
        instanceId: firstOwnerInstanceId,
        machineId,
      });
      const instanceB = await busB.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
        instanceId: secondOwnerInstanceId,
        machineId,
      });
      const instanceC = await busC.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
        instanceId: thirdOwnerInstanceId,
        machineId,
      });
      expect(instanceA.instance).not.toBeNull();
      expect(instanceB.instance).not.toBeNull();
      expect(instanceC.instance).not.toBeNull();
      expect(
        [instanceA.instance?.incarnation, instanceB.instance?.incarnation, instanceC.instance?.incarnation].sort(),
      ).toEqual([1, 2, 3]);
      expect(instanceA.instance?.retiredAt).toBeNull();
      expect(instanceB.instance?.retiredAt).toBeNull();

      const claims = await busA.request(SessionOwnershipStorageSubjects.listClaims, { machineId, adapterId });
      expect(claims.claims).toHaveLength(3);
      expect(new Set(claims.claims.map((claim) => claim.ownerInstanceId))).toEqual(
        new Set([firstOwnerInstanceId, secondOwnerInstanceId, thirdOwnerInstanceId]),
      );
      expect(claims.claims.every((claim) => claim.status === 'held')).toBe(true);
    } finally {
      await executor.run(sql.raw(`DROP TRIGGER IF EXISTS "${triggerName}" ON runtime_instance_incarnation_counters`));
      await executor.run(sql.raw(`DROP FUNCTION IF EXISTS "${functionName}"()`));
    }
  });

  it('allocates three movement-owner incarnations through one Postgres counter row', async () => {
    if (config.dialect !== 'postgres' || sibling === undefined || thirdSibling === undefined) return;

    const fixtures = await Promise.all([seedFixtures(), seedFixtures(), seedFixtures()]);
    const machineId = `machine-movement-incarnation-${crypto.randomUUID()}`;
    const adapterId = `adapter-movement-incarnation-${crypto.randomUUID()}`;
    const ownerIds = fixtures.map((_, index) => `instance-movement-incarnation-${index}-${crypto.randomUUID()}`);
    const lockKey = crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff;
    const functionName = `movement_incarnation_gate_${crypto.randomUUID().replaceAll('-', '_')}`;
    const triggerName = `movement_incarnation_gate_${crypto.randomUUID().replaceAll('-', '_')}`;
    const executor = getRawSqlExecutor(getCtx().db);

    await executor.run(
      sql.raw(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock_shared(${lockKey});
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `),
    );
    await executor.run(
      sql.raw(`
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON runtime_instance_incarnation_counters
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
      `),
    );

    const movementFor = (index: number) => {
      const fixture = fixtures[index]!;
      return {
        machineId,
        adapterId,
        adapterName: 'race-adapter',
        sessionId: fixture.sessionId,
        agentId: fixture.agentId,
        ownerInstance: { instanceId: ownerIds[index]! },
        expectedRevision: 0,
        movement: {
          kind: 'confirmed' as const,
          providerSessionId: `provider-movement-incarnation-${index}-${crypto.randomUUID()}`,
          claimToken: crypto.randomUUID(),
        },
      };
    };

    try {
      const [resultA, resultB, resultC] = await executor.withSession(async (gate) => {
        await gate.run(sql`SELECT pg_advisory_lock(CAST(${String(lockKey)} AS bigint))`);
        let operationA: Promise<SessionOwnershipSettleMovementResult> | undefined;
        let operationB: Promise<SessionOwnershipSettleMovementResult> | undefined;
        let operationC: Promise<SessionOwnershipSettleMovementResult> | undefined;
        let gateReleased = false;
        try {
          operationA = busA.request(SessionOwnershipStorageSubjects.settleMovement, movementFor(0));
          await waitForAdvisoryWaiters(lockKey, 1);
          operationB = busB.request(SessionOwnershipStorageSubjects.settleMovement, movementFor(1));
          await waitForAdvisoryWaiters(lockKey, 2);
          operationC = busC.request(SessionOwnershipStorageSubjects.settleMovement, movementFor(2));
          await waitForAdvisoryWaiters(lockKey, 3);
        } catch (error) {
          await gate.run(sql`SELECT pg_advisory_unlock(CAST(${String(lockKey)} AS bigint))`);
          gateReleased = true;
          await Promise.allSettled([operationA, operationB, operationC].filter((item) => item !== undefined));
          throw error;
        } finally {
          if (!gateReleased) await gate.run(sql`SELECT pg_advisory_unlock(CAST(${String(lockKey)} AS bigint))`);
        }
        if (operationA === undefined || operationB === undefined || operationC === undefined) {
          await Promise.allSettled([operationA, operationB, operationC].filter((item) => item !== undefined));
          throw new Error('counter allocation barrier failed before all movement operations entered');
        }
        return Promise.all([operationA, operationB, operationC]);
      });

      expect([resultA.outcome, resultB.outcome, resultC.outcome]).toEqual(['settled', 'settled', 'settled']);
      const instances = await Promise.all(
        ownerIds.map((instanceId, index) =>
          [busA, busB, busC][index]!.request(SessionOwnershipStorageSubjects.getRuntimeInstance, {
            instanceId,
            machineId,
          }),
        ),
      );
      expect(instances.map(({ instance }) => instance?.incarnation).sort()).toEqual([1, 2, 3]);
    } finally {
      await executor.run(sql.raw(`DROP TRIGGER IF EXISTS "${triggerName}" ON runtime_instance_incarnation_counters`));
      await executor.run(sql.raw(`DROP FUNCTION IF EXISTS "${functionName}"()`));
    }
  });

  it('keeps a second Postgres stable-key transaction blocked until the first commits', async () => {
    const siblingClient = sibling;
    if (config.dialect !== 'postgres' || siblingClient === undefined) return;

    const lock = ownershipClaimTransactionLock({
      machineId: `machine-stable-lock-${crypto.randomUUID()}`,
      adapterId: `adapter-stable-lock-${crypto.randomUUID()}`,
      providerSessionId: `provider-stable-lock-${crypto.randomUUID()}`,
    });
    const releaseFirst = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<number>();
    let secondEntered = false;
    const first = executeTransaction(getCtx().db, async (tx) => {
      await acquireTransactionLocks(getCtx().db, tx, [lock]);
      const [backend] = await tx
        .select({ pid: sql<number>`pg_backend_pid()` })
        .from(sql.raw('(SELECT 1) AS transaction_lock_anchor'));
      if (backend === undefined) throw new Error('first stable-key transaction did not expose a backend PID');
      firstEntered.resolve(backend.pid);
      await releaseFirst.promise;
    });
    const firstPid = await firstEntered.promise;
    const second = executeTransaction(siblingClient.db, async (tx) => {
      await acquireTransactionLocks(siblingClient.db, tx, [lock]);
      secondEntered = true;
    });

    try {
      await waitForBackendBlockedBy(firstPid);
      expect(secondEntered).toBe(false);
    } finally {
      releaseFirst.resolve();
      await Promise.all([first, second]);
    }
    expect(secondEntered).toBe(true);
  });

  it('orders crossed movement claim keys before takeover and retirement', async () => {
    if (config.dialect !== 'postgres' || sibling === undefined) return;

    const first = await seedFixtures();
    const second = await seedFixtures();
    const machineIdA = `machine-crossed-movement-a-${crypto.randomUUID()}`;
    const machineIdB = `machine-crossed-movement-b-${crypto.randomUUID()}`;
    const adapterIdA = `adapter-crossed-movement-a-${crypto.randomUUID()}`;
    const adapterIdB = `adapter-crossed-movement-b-${crypto.randomUUID()}`;
    const providerSessionIdA = `provider-crossed-movement-a-${crypto.randomUUID()}`;
    const providerSessionIdB = `provider-crossed-movement-b-${crypto.randomUUID()}`;
    const ownerA = `instance-crossed-movement-a-${crypto.randomUUID()}`;
    const ownerB = `instance-crossed-movement-b-${crypto.randomUUID()}`;

    const initialA = await busA.request(SessionOwnershipStorageSubjects.claim, {
      ...baseClaimRequest(first.agentId, first.sessionId, machineIdA, adapterIdA, providerSessionIdA, ownerA),
      claimToken: crypto.randomUUID(),
    });
    const initialB = await busA.request(SessionOwnershipStorageSubjects.claim, {
      ...baseClaimRequest(second.agentId, second.sessionId, machineIdB, adapterIdB, providerSessionIdB, ownerB),
      claimToken: crypto.randomUUID(),
    });
    expect(initialA.outcome).toBe('claimed');
    expect(initialB.outcome).toBe('claimed');
    if (initialA.outcome !== 'claimed' || initialB.outcome !== 'claimed') return;

    await busA.request(SessionOwnershipStorageSubjects.retireInstance, { instanceId: ownerA });
    await busA.request(SessionOwnershipStorageSubjects.retireInstance, { instanceId: ownerB });

    const executor = getRawSqlExecutor(getCtx().db);
    const stableKeys = [
      postgresTransactionLockKey(
        ownershipClaimTransactionLock({
          machineId: machineIdA,
          adapterId: adapterIdA,
          providerSessionId: providerSessionIdA,
        }),
      ),
      postgresTransactionLockKey(
        ownershipClaimTransactionLock({
          machineId: machineIdB,
          adapterId: adapterIdB,
          providerSessionId: providerSessionIdB,
        }),
      ),
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const [lowerKey, higherKey] = stableKeys;
    if (lowerKey === undefined || higherKey === undefined || lowerKey === higherKey) {
      throw new Error('crossed movement fixture did not derive two distinct stable claim keys');
    }

    const movementA = () =>
      busA.request(SessionOwnershipStorageSubjects.settleMovement, {
        machineId: machineIdB,
        adapterId: adapterIdB,
        adapterName: 'race-adapter',
        sessionId: first.sessionId,
        agentId: first.agentId,
        ownerInstance: { instanceId: `successor-crossed-movement-a-${crypto.randomUUID()}` },
        expectedRevision: 0,
        movement: {
          kind: 'confirmed' as const,
          providerSessionId: providerSessionIdB,
          claimToken: crypto.randomUUID(),
        },
      });
    const movementB = () =>
      busB.request(SessionOwnershipStorageSubjects.settleMovement, {
        machineId: machineIdA,
        adapterId: adapterIdA,
        adapterName: 'race-adapter',
        sessionId: second.sessionId,
        agentId: second.agentId,
        ownerInstance: { instanceId: `successor-crossed-movement-b-${crypto.randomUUID()}` },
        expectedRevision: 0,
        movement: {
          kind: 'confirmed' as const,
          providerSessionId: providerSessionIdA,
          claimToken: crypto.randomUUID(),
        },
      });

    const [resultA, resultB] = await executor.withSession(async (control) => {
      const [controlBackend] = await control.all<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (controlBackend === undefined) throw new Error('could not identify crossed-movement control backend');
      await control.run(sql`SELECT pg_advisory_lock(CAST(${higherKey.toString()} AS bigint))`);
      let operationA: ReturnType<typeof movementA> | undefined;
      let operationB: ReturnType<typeof movementB> | undefined;
      let controlReleased = false;
      try {
        operationA = movementA();
        const firstMovementPid = await waitForBackendBlockedBy(controlBackend.pid);
        operationB = movementB();
        await waitForBackendBlockedBy(firstMovementPid);
      } catch (error) {
        await control.run(sql`SELECT pg_advisory_unlock(CAST(${higherKey.toString()} AS bigint))`);
        controlReleased = true;
        await Promise.allSettled([operationA, operationB].filter((item) => item !== undefined));
        throw error;
      } finally {
        if (!controlReleased)
          await control.run(sql`SELECT pg_advisory_unlock(CAST(${higherKey.toString()} AS bigint))`);
      }
      if (operationA === undefined || operationB === undefined) {
        await Promise.allSettled([operationA, operationB].filter((item) => item !== undefined));
        throw new Error('crossed movement lock staging failed before both operations entered');
      }
      return Promise.all([operationA, operationB]);
    });

    expect(resultA.outcome).toBe('settled');
    expect(resultB.outcome).toBe('settled');
    const [finalA, finalB] = await Promise.all([
      busA.request(SessionOwnershipStorageSubjects.listClaims, { machineId: machineIdA, adapterId: adapterIdA }),
      busA.request(SessionOwnershipStorageSubjects.listClaims, { machineId: machineIdB, adapterId: adapterIdB }),
    ]);
    expect(finalA.claims).toHaveLength(1);
    expect(finalB.claims).toHaveLength(1);
    expect(finalA.claims[0]).toMatchObject({ agentId: second.agentId, status: 'held' });
    expect(finalB.claims[0]).toMatchObject({ agentId: first.agentId, status: 'held' });
  });

  // ── Case: the session delete's lock order ────────────────────────────────

  it('a session delete takes `agents` before `sessions`, so a concurrent ownership act cannot deadlock', async () => {
    // Postgres only, and deliberately hand-built. Every ownership operation
    // locks `agents` → `adapter_session_claims` → `sessions`; a bare
    // `DELETE FROM sessions` inverts that, taking the session row first and
    // reaching the other two through the foreign-key cascade. The cycle only
    // closes while an ownership transaction is *holding* its agents lock and
    // still wants the session row — a window microseconds wide that firing the
    // two operations concurrently does not reliably hit. So the ownership side
    // is staged statement by statement, with its lock genuinely held, which is
    // the only way to assert a lock order rather than hope for a collision.
    // SQLite has no row locks and cannot express the hazard at all.
    if (config.dialect !== 'postgres' || sibling === undefined) return;
    const { sessionId, agentId } = await seedFixtures();

    await getRawSqlExecutor(getCtx().db).withSession(async (session) => {
      await session.run(sql`BEGIN`);
      try {
        // `lockAgentAllocation`, by hand: the first statement of every ownership
        // transaction, and the lock the delete must not be holding a session row
        // while it waits for.
        await session.all(sql`SELECT agent_id FROM agents WHERE agent_id = ${agentId} FOR UPDATE`);

        const deletion = busB.request(SessionStorageSubjects.delete, { sessionId });
        // The delete must be *blocked on the agents row* before the sessions
        // phase runs, or the two never overlap and the test proves nothing.
        // Asserted rather than slept for: a delete that has already finished
        // would make everything below pass vacuously.
        const pending = Symbol('pending');
        const raced = await Promise.race([
          deletion.then(() => 'completed' as const),
          new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 250)),
        ]);
        expect(raced).toBe(pending);

        // The sessions phase of the ownership transaction. Under the inverted
        // order this statement is the second half of the cycle and Postgres kills
        // one of the two with a deadlock error that no caller retries.
        await session.run(sql`UPDATE sessions SET last_activity_at = last_activity_at WHERE session_id = ${sessionId}`);
        await session.run(sql`COMMIT`);
        await deletion;
      } catch (error) {
        // The pinned connection goes back to the pool, so an open transaction
        // may never be left on it — a failed assertion here would otherwise
        // wedge every suite that borrows the connection next.
        await session.run(sql`ROLLBACK`);
        throw error;
      }
    });

    const session = await busA.request(SessionStorageSubjects.get, { sessionId });
    expect(session.session).toBeNull();
  });
});
