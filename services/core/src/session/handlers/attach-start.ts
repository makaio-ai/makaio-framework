import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionContext, StartAgentResponse } from '@makaio/contracts';
import { seedAttachContextWithHistory } from '../context/seed-attach-context.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { mintClaimToken } from '../ownership/claim-token.js';
import { emitLocalityDegradeEvent } from '../session-lifecycle-events.js';
import { AttachStartError } from './attach-error.js';
import type { AttachIdentity, AttachLocalityResult } from './attach-execution-types.js';
import { persistAttachAgentRow } from './attach-identity-persistence.js';
import { reserveAttachStart, type AttachReservationResult } from './attach-reservation.js';
import { launchAttachAgent, type AttachLaunchTarget } from './attach-runtime-options.js';
import { completeCallerOwnedStart, type CallerOwnedStart } from './caller-owned-start.js';
import { abandonDispatchedStart, rollbackReservedStart, StartClaimTokens } from './lead-start-cleanup.js';

/** Everything the reserved attach needs, resolved before it takes anything. */
export interface ReservedAttachStart {
  /** Caller-minted agent identity the whole attempt runs under. */
  readonly agentId: string;
  /** Adapter target and runtime options the dispatch is composed from. */
  readonly launch: AttachLaunchTarget;
  /** Identity metadata the pre-dispatch row carries. */
  readonly identity: AttachIdentity;
  /** The **structural** locality verdict; the reservation produces the final one. */
  readonly locality: AttachLocalityResult;
  /** Lead the caller observed on the session row, or `null` when it names none. */
  readonly expectedLeadAgentId: string | null;
  /** Machine identity every ownership act names, or `undefined` for the authority's own. */
  readonly machineId: string | undefined;
}

/** A dispatched attach, and everything its completion or its unwinding needs. */
export interface StartedAttachAgent {
  /** The started adapter agent, always carrying the identity attach minted. */
  readonly startResult: Extract<StartAgentResponse, { success: true }>;
  /** History-seeded context for a non-native attach, `undefined` for a native resume. */
  readonly sessionContext: SessionContext | undefined;
  /** The dispatched start, as its settlement, its commit and its rollback need it. */
  readonly dispatched: CallerOwnedStart;
}

/**
 * Run a reserved attach up to a live, settled connector.
 *
 * **The order is the content.** The row exists before the reservation, the
 * reservation before the history seeding, and the seeding before the dispatch:
 *
 * 1. the caller-owned `starting` row, so the reservation has a membership to
 *    check and no later write can overwrite the status the settlement depends on;
 * 2. the reservation, which produces the **final** locality verdict — a
 *    structurally native attach whose key is held elsewhere becomes non-native
 *    here and nowhere else;
 * 3. the history seeding, branching on that final verdict. Seeding from the
 *    *structural* one is the bug this ordering exists to prevent: an attach that
 *    degraded at the reservation would dispatch with neither a resume target nor
 *    seeded history — an empty provider context, and a user silently losing the
 *    conversation instead of continuing it without native resume;
 * 4. the dispatch, which supplies `agentId` and therefore suppresses both the
 *    adapter's own row write and its own reservation;
 * 5. the settlement, on the provider session the connector reported.
 *
 * Every failure before the dispatch deletes the row and gives the key back
 * cleanly; every failure from the dispatch onward keeps the row as `dead` and
 * retires the key, because nothing after that point can prove the provider is
 * not holding a live session.
 * @param bus - Bus every step is issued on.
 * @param input - The attach to run, resolved but for its final verdict.
 * @returns The live connector, its context, and the handle its completion needs.
 * @throws An {@link AttachStartError} for every refusal this seam models.
 */
export async function startReservedAttachAgent(
  bus: IMakaioBus,
  input: ReservedAttachStart,
): Promise<StartedAttachAgent> {
  const { agentId, launch, identity } = input;
  try {
    await persistAttachAgentRow(bus, {
      agentId,
      adapterId: launch.adapterId,
      identity,
      runtime: {
        ...launch.effectiveRuntimeOptions,
        ...(launch.harnessId !== undefined && { harnessId: launch.harnessId }),
      },
    });
  } catch (error) {
    // **The row write is inside the pre-dispatch rollback, not in front of it.**
    // A write whose transaction commits and whose response is then lost throws
    // with the row already stored: no reservation, no owner, no connector, and —
    // once the exclusive-start entry is gone — a `starting` row the in-flight
    // rule arbitrates as a phantom attach. Which is why the adapter records its
    // own row acquisition at the write's *issue* rather than its return (I20);
    // this path had the rollback and simply did not cover the write.
    await rollbackReservedStart(bus, agentId, undefined);
    throw new AttachStartError(
      'start-failed',
      `[attach-handler] persisting the agent row for ${agentId} failed`,
      'not-dispatched',
      { cause: error },
    );
  }

  const reserved = await reserveOrRollBack(bus, input);
  const reservation = reserved.reservation;
  const native = reserved.kind === 'reserved' && reservation?.claim != null;
  if (reserved.kind === 'degrade') {
    void emitLocalityDegradeEvent(bus, {
      sessionId: identity.sessionId,
      intent: 'resume',
      verdict: { kind: 'degrade', reason: reserved.reason },
      adapterId: launch.adapterId,
    });
  }

  // Under the same pre-dispatch rollback as the reservation, and for the same
  // reason: by this point the row exists and the reservation may hold a key and
  // a designation, while nothing has reached the provider. A conversation read
  // that throws — storage down, a session whose history cannot be assembled —
  // would otherwise walk out of here leaving all three behind, and the caller
  // has no handle yet with which to take them back.
  let sessionContext: SessionContext | undefined;
  try {
    sessionContext = native ? undefined : await seedFinalContext(bus, input);
  } catch (error) {
    await rollbackReservedStart(bus, agentId, reservation);
    throw new AttachStartError(
      'start-failed',
      `[attach-handler] seeding the conversation for agent ${agentId} failed`,
      'not-dispatched',
      { cause: error },
    );
  }
  const claimTokens = new StartClaimTokens([reservation?.claim?.claimToken]);
  // Minted before the settle and releasable from the moment it exists: a
  // settlement whose transaction commits and whose response is then lost leaves
  // nothing else that names the successor generation (I15b).
  const settlementClaimToken = mintClaimToken();
  claimTokens.add(settlementClaimToken);
  const dispatched: CallerOwnedStart = {
    sessionId: identity.sessionId,
    agentId,
    adapterId: launch.adapterId,
    adapterName: identity.adapterName,
    claimTokens,
    settlementClaimToken,
    policy: { writesAgentStatus: true, ...(reservation !== undefined && { reservation }) },
    ...(identity.providerConfigId !== undefined && { providerConfigId: identity.providerConfigId }),
    ...(input.machineId !== undefined && { machineId: input.machineId }),
  };

  const startResult = await dispatchAttach(bus, input, dispatched, {
    ...launch,
    agentId,
    ...(native && input.locality.resumeAdapterSessionId !== undefined
      ? { resumeAdapterSessionId: input.locality.resumeAdapterSessionId }
      : {}),
    ...(sessionContext !== undefined && { attachSessionContext: sessionContext }),
  });

  // Settlement and commit under one guard, so a throw from either leaves no
  // dispatched attach without a handle: `startReservedAttachAgent` would exit
  // with the row `starting`, the generation held, the designation standing and
  // the connector live, and its caller has nothing left to retire.
  //
  // Committed here, and not after the initial turn: a row still in `starting`
  // while a turn is in flight misinforms every consumer of it, and the adapter's
  // per-turn `active` stamp — which only ever moves the row between the two
  // activity states — would find nothing it may write. The start ends at its
  // settlement, exactly as Path A's does; the initial turn is the next
  // operation, not the last stage of this one.
  await completeCallerOwnedStart(bus, dispatched, startResult.adapterSessionId);
  return { startResult, sessionContext, dispatched };
}

/**
 * Retire a dispatched attach whose later stage failed — §7.4's post-dispatch row.
 *
 * `abandoned` and never a deletion: deleting the row cascades its claims away
 * and thereby frees an ownership key for a provider session nobody has proven is
 * closed. The designation goes with it, because the policy names the reservation
 * that made it — a session pointed at a `dead` lead with no connector is worse
 * than one pointed at nothing.
 *
 * The second transition is what the shared cleanup cannot express. It unwinds a
 * start still in `starting`; an attach that failed at its *initial turn* has
 * already committed, and the connector it is about to stop last stamped the row
 * `idle` or `active`. Left there, the row advertises an agent this runtime can
 * drive and no longer can — the phantom the whole reserved-start discipline
 * exists to remove.
 * @param bus - Bus the cleanup is issued on.
 * @param started - The dispatched attach being retired.
 */
export async function retireStartedAttach(bus: IMakaioBus, started: StartedAttachAgent): Promise<void> {
  const { dispatched } = started;
  await abandonDispatchedStart(bus, dispatched.agentId, dispatched.policy, dispatched.claimTokens);
  await bus.requestOptional(AgentStorageSubjects.updateStatus, {
    agentId: dispatched.agentId,
    status: 'dead',
    expectedStatus: ['idle', 'active'],
  });
}

/**
 * Take the reservation, and give the pre-dispatch row back on every refusal.
 *
 * All four refusals are pre-dispatch by construction, so all four carry
 * `not-dispatched` and take the deleting branch. A `lead-conflict` is a **full**
 * rollback and nothing else: attach does not re-read the session and adopt the
 * winner as a member, because a member reservation validates no lead at all and
 * making the adoption safe would need an atomic "reserve as member iff this
 * other agent is still the lead" predicate — a storage change this wave does not
 * make. The caller retries from a fresh session read if it wants a member.
 * @param bus - Bus the reservation is issued on.
 * @param input - The attach being reserved for.
 * @returns The verdict this attach dispatches under.
 * @throws An {@link AttachStartError} carrying `not-dispatched` for every refusal.
 */
async function reserveOrRollBack(
  bus: IMakaioBus,
  input: ReservedAttachStart,
): Promise<Extract<AttachReservationResult, { kind: 'reserved' | 'degrade' }>> {
  const { agentId, identity, launch } = input;
  let reserved: AttachReservationResult;
  try {
    reserved = await reserveAttachStart(bus, {
      sessionId: identity.sessionId,
      agentId,
      adapterId: launch.adapterId,
      adapterName: identity.adapterName,
      role: identity.role,
      resumeProviderSessionId: input.locality.resumeAdapterSessionId ?? null,
      expectedLeadAgentId: input.expectedLeadAgentId,
      ...(input.machineId !== undefined && { machineId: input.machineId }),
    });
  } catch (error) {
    await rollbackReservedStart(bus, agentId, undefined);
    throw new AttachStartError(
      'reservation-refused',
      `[attach-handler] reserving the start of agent ${agentId} failed`,
      'not-dispatched',
      { cause: error },
    );
  }
  if (reserved.kind === 'reserved' || reserved.kind === 'degrade') return reserved;

  // Nothing was designated and nothing was claimed — a refused reservation rolls
  // its whole transaction back — so the row this attempt wrote is all there is
  // to take back.
  await rollbackReservedStart(bus, agentId, undefined);
  if (reserved.kind === 'conflict') {
    throw new AttachStartError(
      'lead-conflict',
      `[attach-handler] session ${identity.sessionId} is led by ${reserved.currentLeadAgentId ?? 'no agent'}, not by ${agentId}`,
      'not-dispatched',
    );
  }
  throw new AttachStartError(
    'reservation-refused',
    `[attach-handler] reservation for agent ${agentId} was refused: ${reserved.outcome}`,
    'not-dispatched',
  );
}

/**
 * Seed the history a non-native attach continues the conversation from.
 *
 * Branches on the **final** verdict: a reservation-driven degrade has no
 * structural context to seed, so one is composed from the verdict the
 * reservation produced.
 * @param bus - Bus the conversation is read on.
 * @param input - The attach being started.
 * @returns The seeded session context.
 */
async function seedFinalContext(bus: IMakaioBus, input: ReservedAttachStart): Promise<SessionContext> {
  const context: SessionContext = input.locality.attachSessionContext ?? {
    nativeLocality: { kind: 'degrade', reason: 'agent-already-started' },
  };
  return seedAttachContextWithHistory(bus, input.identity.sessionId, context);
}

/**
 * Dispatch the reserved attach, and unwind by the disposition it reports.
 *
 * The disposition is the whole reason `launchAttachAgent` raises an
 * {@link AttachStartError} instead of a bare `Error`: a modeled
 * `not-dispatched` refusal is provably pre-dispatch and gives the key back
 * cleanly, while a throw carries no disposition at all and must retire it.
 * @param bus - Bus the dispatch is issued on.
 * @param input - The attach being started.
 * @param dispatched - The start's cleanup handle.
 * @param target - The composed launch target.
 * @returns The successful start, re-stamped with the identity attach minted.
 */
async function dispatchAttach(
  bus: IMakaioBus,
  input: ReservedAttachStart,
  dispatched: CallerOwnedStart,
  target: Parameters<typeof launchAttachAgent>[1],
): Promise<Extract<StartAgentResponse, { success: true }>> {
  const { agentId } = input;
  let startResult: Extract<StartAgentResponse, { success: true }>;
  try {
    startResult = await launchAttachAgent(bus, target);
  } catch (error) {
    const notDispatched = error instanceof AttachStartError && error.dispatch === 'not-dispatched';
    if (notDispatched) await rollbackReservedStart(bus, agentId, dispatched.policy.reservation);
    else await abandonDispatchedStart(bus, agentId, dispatched.policy, dispatched.claimTokens);
    throw error;
  }
  // The adapter echoes the identity it was given, but the row this attempt owns
  // is the one it minted — so every consumer downstream reads it from here.
  //
  // **Nothing fallible runs between here and the settlement.** The connector is
  // live on the key it confirmed — which for a degraded attach, or one whose
  // provider declined the resume, is not the key that was reserved — and until
  // the settlement claims that key, nothing holds it. A storage round trip
  // wedged in here is a window in which another runtime reserves the session
  // this connector is already speaking to, and a failure in that round trip
  // retires a reservation that never named the confirmed key at all. The
  // session-close revalidation that used to sit here now runs after the start is
  // complete, where the teardown for a committed start already lives.
  return { ...startResult, agentId };
}
