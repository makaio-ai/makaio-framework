/**
 * The release discipline a failed start runs under — I15b, cases 87-89.
 *
 * A failed start gives back exactly the generations it can name and never fans
 * out over the agent's claims, because an agent legitimately holds a second
 * generation from a movement this attempt never observed. Everything here runs
 * against the real ownership authority and the real memory backends through the
 * real bus: the claim rows the cleanup leaves behind *are* the assertion, and a
 * stubbed ownership seam would prove only that a function was called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type AdapterSessionClaimRecord,
  type SessionOwnershipReservation,
  type SessionOwnershipSettleMovementServiceResult,
} from '@makaio/contracts';
import { MakaioSessionService } from '../../session-service.js';
import { AgentStorageSubjects } from '../../storage/agent-namespace.js';
import { SessionStartError } from '../session-start-error.js';
import {
  abandonDispatchedStart,
  applySettlementOutcome,
  StartClaimTokens,
  type StartCleanupPolicy,
} from '../lead-start-cleanup.js';
import { createTestAgent, registerMemorySessionBackends } from '../../__tests__/shared.js';

/** Machine the authority is composed with, and therefore claims under. */
const MACHINE_ID = 'cleanup-machine';
/** The live instance every reservation and settlement in this suite names. */
const ADAPTER_ID = 'cleanup-adapter-instance';
/** Adapter type name carried onto every claim. */
const ADAPTER_NAME = 'test-adapter';

/** The caller-owned side of the phase table (Path A), so status writes are visible. */
const CALLER_OWNED: StartCleanupPolicy = { writesAgentStatus: true };

describe('start cleanup release discipline (I15b)', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let cleanups: Array<() => void> = [];
  let stoppedAgentIds: string[];

  beforeEach(async () => {
    stoppedAgentIds = [];
    bus = createBusInstance();
    cleanups = [
      ...registerMemorySessionBackends(bus),
      bus.on(AdapterSubjects.stopAgent, (ctx) => {
        stoppedAgentIds.push(ctx.payload.agentId);
        ctx.setResult({ success: true, evidence: 'released' });
      }),
    ];
    service = new MakaioSessionService(bus, { machineId: MACHINE_ID });
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Create a session with one `starting` agent on it.
   * @param sessionId - Session to create.
   * @param agentId - Agent to persist into it.
   * @returns The agent identity, for the caller's convenience.
   */
  async function seedStartingAgent(sessionId: string, agentId: string): Promise<string> {
    await bus.request(SessionSubjects.create, { sessionId, machineId: MACHINE_ID });
    await bus.request(AgentStorageSubjects.set, {
      agentId,
      agent: createTestAgent(agentId, {
        sessionId,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        status: 'starting',
      }),
    });
    return agentId;
  }

  /**
   * Take a real member reservation on one provider-session key.
   * @param sessionId - Session the reservation is taken in.
   * @param agentId - Agent the reservation is taken for.
   * @param providerSessionId - Key to reserve.
   * @returns The committed reservation.
   */
  async function reserve(
    sessionId: string,
    agentId: string,
    providerSessionId: string,
  ): Promise<SessionOwnershipReservation> {
    const result = await bus.request(SessionSubjects.ownership.reserveStart, {
      sessionId,
      agentId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      role: 'member',
      resumeProviderSessionId: providerSessionId,
    });
    if (result.outcome !== 'reserved') throw new Error(`reservation refused: ${result.outcome}`);
    return result.reservation;
  }

  /**
   * Settle a confirmed movement through the authority.
   * @param sessionId - Session the movement belongs to.
   * @param agentId - Agent that moved.
   * @param providerSessionId - Provider session the conversation now lives at.
   * @returns What the authority answered.
   */
  function settle(
    sessionId: string,
    agentId: string,
    providerSessionId: string,
  ): Promise<SessionOwnershipSettleMovementServiceResult> {
    return bus.request(SessionSubjects.ownership.settleMovement, {
      sessionId,
      agentId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      movement: { confirmed: true, providerSessionId },
    });
  }

  /**
   * List every claim on the test machine, keyed for readable assertions.
   * @returns The claims, as `[providerSessionId, status]` pairs.
   */
  async function claimStates(): Promise<Array<[string, string]>> {
    const { claims } = await bus.request(SessionOwnershipStorageSubjects.listClaims, { machineId: MACHINE_ID });
    return claims
      .map((claim: AdapterSessionClaimRecord): [string, string] => [claim.providerSessionId, claim.status])
      .sort((left, right) => left[0].localeCompare(right[0]));
  }

  it('releases only the generations the attempt names, leaving an unrelated one held (case 87)', async () => {
    const sessionId = 'cleanup-token-scoped';
    const agentId = await seedStartingAgent(sessionId, 'agent-token-scoped');
    const mine = await reserve(sessionId, agentId, 'provider-mine');
    // A second generation of the *same* agent, standing in for one another
    // process allocated while this start was in flight. A fan-out would take it.
    const foreign = await reserve(sessionId, agentId, 'provider-foreign');
    expect(mine.claim?.claimToken).not.toBe(foreign.claim?.claimToken);

    await abandonDispatchedStart(bus, agentId, CALLER_OWNED, new StartClaimTokens([mine.claim?.claimToken]));

    expect(await claimStates()).toEqual([
      ['provider-foreign', 'held'],
      ['provider-mine', 'abandoned'],
    ]);
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId });
    expect(agent?.status).toBe('dead');
  });

  it('names nothing, and therefore releases nothing, when the attempt took no generation (case 87)', async () => {
    // The keyless reservation a fresh lead start takes holds no claim, so its
    // post-dispatch cleanup has no generation to give back — and must not reach
    // for one the agent happens to hold.
    const sessionId = 'cleanup-keyless';
    const agentId = await seedStartingAgent(sessionId, 'agent-keyless');
    await reserve(sessionId, agentId, 'provider-unrelated');

    await abandonDispatchedStart(bus, agentId, CALLER_OWNED, new StartClaimTokens([undefined]));

    expect(await claimStates()).toEqual([['provider-unrelated', 'held']]);
  });

  it.each([
    { outcome: 'already-claimed' as const, code: 'ownership-refused', status: 'abandoned', rowStatus: 'dead' },
    { outcome: 'superseded' as const, code: 'ownership-refused', status: 'abandoned', rowStatus: 'dead' },
    { outcome: 'not-owner' as const, code: 'ownership-refused', status: 'abandoned', rowStatus: 'dead' },
  ])('releases the named generation token-scoped and stops the connector on $outcome (case 88)', async ({
    outcome,
    code,
    status,
    rowStatus,
  }) => {
    const sessionId = `cleanup-refused-${outcome}`;
    const agentId = await seedStartingAgent(sessionId, `agent-refused-${outcome}`);
    const mine = await reserve(sessionId, agentId, 'provider-mine');
    await reserve(sessionId, agentId, 'provider-foreign');
    const refusal = buildRefusal(outcome);

    const failure = await applySettlementOutcome(
      bus,
      ADAPTER_ID,
      agentId,
      refusal,
      CALLER_OWNED,
      new StartClaimTokens([mine.claim?.claimToken]),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionStartError);
    expect(failure instanceof SessionStartError ? failure.code : undefined).toBe(code);
    expect(stoppedAgentIds).toEqual([agentId]);
    expect(await claimStates()).toEqual([
      ['provider-foreign', 'held'],
      ['provider-mine', status],
    ]);
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId });
    expect(agent?.status).toBe(rowStatus);
  });

  it('releases both the reservation and the generation the settlement reported (case 89)', async () => {
    // The observer-first interleaving of §8.2b: the movement observer settles
    // the connector's key under its own generation, this attempt reserves a
    // second key, and its settle then re-enters on the observer's row — so the
    // effective generation is one the reservation cannot name.
    const sessionId = 'cleanup-effective-generation';
    const agentId = await seedStartingAgent(sessionId, 'agent-effective-generation');
    const observed = await settle(sessionId, agentId, 'provider-observed');
    expect(observed.outcome).toBe('settled');
    const observerToken = observed.outcome === 'settled' ? observed.claim.claimToken : undefined;

    const mine = await reserve(sessionId, agentId, 'provider-mine');
    const claimTokens = new StartClaimTokens([mine.claim?.claimToken]);

    const settled = await settle(sessionId, agentId, 'provider-observed');
    expect(settled.outcome).toBe('idempotent');
    expect(settled.outcome === 'idempotent' ? settled.claim?.claimToken : undefined).toBe(observerToken);
    // Accepted, so it returns — and the effective generation is recorded on the
    // way through, which is the whole point of recording before deciding.
    await applySettlementOutcome(bus, ADAPTER_ID, agentId, settled, CALLER_OWNED, claimTokens);

    // The later failure: the status compare-and-swap this attempt loses.
    await abandonDispatchedStart(bus, agentId, CALLER_OWNED, claimTokens);

    expect(await claimStates()).toEqual([
      ['provider-mine', 'abandoned'],
      ['provider-observed', 'abandoned'],
    ]);
  });

  it('mints the successor generation under the token the caller supplied', async () => {
    // §8.2b's seam: a caller that has a rollback to perform must be able to name
    // the generation its own settlement created without seeing the response.
    const sessionId = 'cleanup-caller-token';
    const agentId = await seedStartingAgent(sessionId, 'agent-caller-token');
    const claimToken = crypto.randomUUID();

    const settled = await bus.request(SessionSubjects.ownership.settleMovement, {
      sessionId,
      agentId,
      adapterId: ADAPTER_ID,
      adapterName: ADAPTER_NAME,
      movement: { confirmed: true, providerSessionId: 'provider-caller-token' },
      claimToken,
    });

    expect(settled.outcome).toBe('settled');
    expect(settled.outcome === 'settled' ? settled.claim.claimToken : undefined).toBe(claimToken);
    // And the attempt can give it back naming nothing but what it minted.
    await abandonDispatchedStart(bus, agentId, CALLER_OWNED, new StartClaimTokens([claimToken]));
    expect(await claimStates()).toEqual([['provider-caller-token', 'abandoned']]);
  });

  it('mints its own generation for a caller that names none', async () => {
    // The movement observer, unchanged: it has no cleanup to perform and
    // nothing to name, so it omits the field and the authority mints.
    const sessionId = 'cleanup-minted-token';
    const agentId = await seedStartingAgent(sessionId, 'agent-minted-token');

    const settled = await settle(sessionId, agentId, 'provider-minted-token');

    expect(settled.outcome).toBe('settled');
    expect(settled.outcome === 'settled' ? settled.claim.claimToken : '').toMatch(/^[0-9a-f-]{36}$/u);
  });
});

/**
 * Build one modeled §7.5 refusal, shaped exactly as the authority returns it.
 *
 * The refusals are the cleanup's *input*, not the seam under test — everything
 * the cleanup then does runs against the real authority and the real claim
 * rows. Two of the three (`superseded`, `not-owner`) have no reachable
 * production interleaving in a single-process test, and constructing the
 * response is the honest way to pin that all three take the same tabulated row.
 * @param outcome - Which refusal to build.
 * @returns The settle result to hand the cleanup.
 */
function buildRefusal(
  outcome: 'already-claimed' | 'superseded' | 'not-owner',
): SessionOwnershipSettleMovementServiceResult {
  if (outcome === 'already-claimed') {
    return {
      outcome,
      holder: {
        claimId: 'holder-claim',
        machineId: MACHINE_ID,
        adapterId: ADAPTER_ID,
        adapterName: ADAPTER_NAME,
        providerSessionId: 'provider-held-elsewhere',
        sessionId: 'other-session',
        agentId: 'other-agent',
        claimToken: 'holder-token',
        fence: 1,
        status: 'held',
        claimedAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
  }
  if (outcome === 'superseded') return { outcome, currentFence: 7 };
  return { outcome };
}
