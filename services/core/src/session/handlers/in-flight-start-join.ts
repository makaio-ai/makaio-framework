import type { IMakaioBus } from '@makaio/bus-core';
import { SessionOwnershipStorageSubjects, type IMakaioSession, type MakaioSessionAgent } from '@makaio/contracts';
import { peekInFlightStart, runExclusiveStart, type StartAttemptOutcome } from '../ownership/index.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { resolveOwnedAdapterInstance, toMachineScopedAdapterInstance } from '../utils/resolution.js';
import {
  failedRehydrateError,
  runReservedRehydrate,
  type ReservedRehydrateOutcome,
  type ReservedRehydrateRequest,
} from './reserved-rehydrate.js';
import {
  buildRecoveryReservationGuard,
  MAX_RECOVERY_REPLANS,
  recoveryProviderSessionId,
  recoverySnapshotIsClaimable,
  readRecoveryPlanningSnapshot,
} from './recovery-reservation.js';
import { SessionStartError } from './session-start-error.js';

/**
 * How many times one agent's row may be observed as `starting` before the send
 * gives up on it.
 *
 * Two: once after joining this process's attempt, and once after the
 * cross-process status compare-and-swap. A third observation means neither the
 * join nor the arbitration resolved the row, and looping would turn a
 * contended session into a stalled send.
 */
const MAX_STARTING_OBSERVATIONS = 2;

/**
 * How many whole-session refresh passes may be invalidated by local joins.
 *
 * A local join is another observed start contention, only widened from one row
 * to every row that was materialized beside it. Keep its bound aligned with the
 * per-row rule rather than letting an unbounded sequence of fresh local starts
 * hold a send forever.
 */
export const MAX_JOINED_REFRESH_PASSES = MAX_STARTING_OBSERVATIONS;

/** What a consumer does with an agent whose start it joined or arbitrated. */
export type StartResolution =
  /** The agent is usable as it stands. */
  | 'use'
  /** The agent is not part of this send: the row is gone, or terminal. */
  | 'drop'
  /** The agent belongs to a guarded recovery this runtime cannot prove retired. */
  | 'defer'
  /** The agent needs the ordinary fresh-with-history recovery. */
  | 'recover';

/** How a send's target set changed once every in-flight start was resolved. */
export interface InFlightStartResolution {
  /** Agents that left the session's target set — deleted or `disposed` rows. */
  readonly droppedAgentIds: ReadonlySet<string>;
  /** Agents this send must recover before using. */
  readonly recoveringAgentIds: ReadonlySet<string>;
  /** Agents whose guarded recovery is owned by an unretired or unknown runtime. */
  readonly deferredAgentIds: ReadonlySet<string>;
  /**
   * The subset whose recovery this send claimed by **compare-and-swap**, not by
   * consuming a local attempt.
   *
   * The two provenances carry different evidence and must not be treated alike.
   * A locally joined attempt reported its own verdict: this process ran it, and
   * it said whether a connector exists. A won compare-and-swap says only that
   * this caller wrote a status first — the attempt it outran belongs to a
   * process this runtime cannot see, and Wave 3 has no way to ask whether that
   * process is alive (OQ-B, deferred to Wave 4). Writing `dead` does not make
   * the agent dead, so a consumer must still find out for itself before opening
   * a second lifecycle.
   */
  readonly arbitratedAgentIds: ReadonlySet<string>;
}

/**
 * Decide what a re-read agent row means for the consumer that joined its start.
 *
 * For the starts this file resolves — the fresh ones, which own their agent row
 * — the row is authoritative in every case, never the joined promise's outcome:
 * a pre-dispatch failure both deletes the row and rejects the attempt, so a rule
 * that read the rejection would contradict the deleted-row rule for one and the
 * same event.
 *
 * **That rests on the attempt writing the row when it fails**, which every
 * reserved start now does: the fresh path deletes before its dispatch and
 * compare-and-swaps to `dead` after one, and the reserved rehydrate claims
 * `starting` before it reserves and puts the row back on every way out. Those
 * writes are still *advisory* — a peer that has since claimed the recovery
 * legitimately wins the swap — so a caller that can observe its attempt's own
 * rejection reads that first and reaches this table only for an attempt that
 * resolved normally.
 *
 * Exported so every consumer classifies a *successful* joined attempt by one
 * table, rather than each growing its own copy.
 * @param agent - The row as it stands after the join, or `null` when it is gone.
 * @returns The resolution, or `undefined` when the row is still `starting`.
 */
export function classifyJoinedRow(agent: MakaioSessionAgent | null): StartResolution | undefined {
  if (agent === null) return 'drop';
  switch (agent.status) {
    case 'idle':
    case 'active':
      return 'use';
    case 'dead':
      return 'recover';
    case 'disposed':
      // Ownership is absorbing on `disposed`: never reserve or settle for it.
      return 'drop';
    case 'starting':
      return undefined;
  }
}

/**
 * Take back a `dead` row for an agent whose connector answers.
 *
 * The two facts cannot both be true: every path that writes `dead` for a start
 * it is unwinding stops the connector in the same breath, so a registered agent
 * answering a probe means the row is describing a runtime that exists. It is the
 * arbitration's own residue — the compare-and-swap that claims a recovery writes
 * `dead` before anything has asked whether a connector is there, deliberately,
 * because that write *is* the cross-process claim (§4.5) and a probe cannot come
 * first without dismantling it. When the probe then vetoes the recovery, the
 * claim was answered but its mark is left standing on a live agent.
 *
 * **And nothing else lifts it.** The per-turn activity stamp moves a row only
 * between `idle` and `active` (deliberately, so a stamp can neither revive a
 * disposed agent nor stomp a `starting` one), so a row left `dead` stays `dead`
 * for the rest of that agent's life while it serves turns — and every consumer
 * that reads status without probing reads a live agent as recoverable.
 *
 * **This is not an activity stamp and the distinction is the whole
 * justification.** A stamp reports what a turn is doing and is refused outside
 * `idle`/`active` for that reason. This is the recovery decision itself,
 * written by the caller that wrote the `dead` it corrects, on evidence gathered
 * after it: a connector answered. `idle` rather than `active` because the probe
 * proves existence, not occupancy — and if a turn is in flight, the next stamp
 * says `active`, which from `idle` it may.
 *
 * Compare-and-swapped from `dead` alone: anything else means a newer writer has
 * since spoken for the row — the out-raced start completing, a removal, a peer's
 * own claim — and every one of those outranks this correction, which is why the
 * refusal is accepted silently (I21′: the status write is advisory).
 * @param bus - Bus the compare-and-swap is issued on.
 * @param agentId - Agent whose row contradicts its connector.
 */
export async function restoreProbedLiveAgent(bus: IMakaioBus, agentId: string): Promise<void> {
  await bus.requestOptional(AgentStorageSubjects.updateStatus, {
    agentId,
    status: 'idle',
    expectedStatus: ['dead'],
  });
}

/**
 * Read an agent row, treating a host without agent storage as "unchanged".
 * @param bus - Bus the read is issued on.
 * @param agentId - Agent to read.
 * @param fallback - Row to answer with when no agent storage is registered.
 * @returns The stored row, or `null` when it is gone.
 */
async function readAgentRow(
  bus: IMakaioBus,
  agentId: string,
  fallback: MakaioSessionAgent,
): Promise<MakaioSessionAgent | null> {
  const result = await bus.requestOptional(AgentStorageSubjects.get, { agentId });
  return result.handled ? result.data.agent : fallback;
}

/**
 * Whether durable storage proves the exact runtime that owns a guarded recovery retired.
 *
 * Absence, an unhandled subject and read errors are deliberately inconclusive:
 * an exact fence identifies the write it may make, but does not grant another
 * runtime authority to make that write.
 * @param bus - Bus the runtime-instance read is issued on.
 * @param agent - Guarded recovery row whose owner may have retired.
 * @returns `true` only when durable retirement evidence exists for that owner.
 */
async function guardedRecoveryOwnerIsRetired(bus: IMakaioBus, agent: MakaioSessionAgent): Promise<boolean> {
  const owner = agent.runtimeOwner;
  if (owner === undefined) return false;
  try {
    const result = await bus.requestOptional(SessionOwnershipStorageSubjects.getRuntimeInstance, {
      instanceId: owner.instanceId,
      machineId: owner.machineId,
    });
    return result.handled && result.data.instance !== null && result.data.instance.retiredAt !== null;
  } catch {
    return false;
  }
}

/** The authoritative result of resolving a row observed as `starting`. */
interface StartingAgentResolution {
  readonly resolution: StartResolution;
  readonly row: MakaioSessionAgent | null;
  readonly arbitrated: boolean;
  readonly joined: boolean;
}

/**
 * Resolve one agent whose stored status is `starting`.
 *
 * Two arbiters, in this order. The process-local registry makes the
 * same-process case exact: an entry means this runtime is driving the attempt,
 * so the send joins it rather than racing it. No entry means the attempt belongs
 * to a process that is gone or to a live peer, neither of which the registry can
 * see — so the send claims the recovery through a status compare-and-swap
 * instead, which the peer's own completion will then lose against and report.
 * **The row it classified is the row it hands back.** Two different questions get
 * answered from the same read: *what state is this identity in*, which decides
 * the resolution, and *what does this identity now look like*, which the send
 * needs because the attempt it joined may have bound the agent to a different
 * adapter instance than the snapshot carries. Classifying the fresh row and then
 * leaving the caller on the stale one would probe and dispatch at an instance
 * the attempt moved off — the same read answering one question and not the
 * other.
 * @param bus - Bus the reads and the compare-and-swap are issued on.
 * @param agent - The agent as the session row carries it.
 * @returns What this send does with the agent, the row that decided it, and
 *   whether it joined a local attempt or decided through the cross-process
 *   compare-and-swap.
 */
async function resolveStartingAgent(bus: IMakaioBus, agent: MakaioSessionAgent): Promise<StartingAgentResolution> {
  let current: MakaioSessionAgent | null = agent;
  let joined = false;
  for (let observation = 0; observation < MAX_STARTING_OBSERVATIONS; observation += 1) {
    const inFlight = peekInFlightStart(agent.agentId);
    if (inFlight !== undefined) {
      // Awaited for its timing, and the row read for its answer. This resolution
      // is about the *identity's* state — the attempt may have deleted the row
      // it was starting — which is the half the verdict deliberately does not
      // speak to.
      //
      // **And the verdict must not be read here — not merely need not be.** A
      // `no-connector` attempt says one thing: *it* built none. A recovery that
      // was refused or deferred puts the row back at the `idle` its claim
      // swapped out, and that row may well have a live connector behind it —
      // the reservation refused because another generation owns the provider
      // session, not because this agent lost anything. Turning that verdict into
      // `recover` would put the agent in the recovering set, which is the one
      // set this rule's consumers rebuild **without probing**, and a rehydrate
      // dispatched onto a live connector replaces it. The connector question is
      // answered one step later, by the liveness probe every consumer runs over
      // the agents this rule did not claim — which is where a question about
      // connectors belongs.
      await inFlight.settled.catch(() => undefined);
      joined = true;
    } else {
      // A guarded recovery owns `starting` through its attempt fence, not its
      // status alone. Refresh before arbitrating so an observer that read the
      // row before the reservation still addresses the persisted attempt; a
      // stale observer can then terminalize only that exact attempt and binding.
      current = await readAgentRow(bus, agent.agentId, current ?? agent);
      if (current?.status === 'starting' && current.recoveryAttemptId !== undefined) {
        const owner = current.runtimeOwner;
        if (owner === undefined || !(await guardedRecoveryOwnerIsRetired(bus, current))) {
          return { resolution: 'defer', row: current, arbitrated: false, joined };
        }
        await bus.request(SessionOwnershipStorageSubjects.finalizeRecovery, {
          agentId: current.agentId,
          attemptId: current.recoveryAttemptId,
          binding: {
            adapterId: current.adapterId,
            ownerMachineId: owner.machineId,
            ownerInstanceId: owner.instanceId,
          },
          action: { kind: 'failed' },
        });
      } else {
        const claimed = await bus.requestOptional(AgentStorageSubjects.updateStatus, {
          agentId: agent.agentId,
          status: 'dead',
          expectedStatus: ['starting'],
        });
        if (!claimed.handled || claimed.data.transitioned) {
          // Two different facts reach the same resolution, and they must not reach
          // the same *row*. A transitioned swap means this call won the
          // arbitration and the stored row now says `dead`. An unhandled subject
          // means there is no agent storage to arbitrate over at all — the session
          // package does not depend on it — which the reserved recovery already
          // treats as "claimed" for the same reason: refusing would make the whole
          // path unavailable to a composition that never had the column.
          //
          // **The row is read, never constructed.** Synthesising a `dead` row for
          // the unhandled case would hand the send a state no storage holds and no
          // write produced, and the caller now carries that row into its liveness
          // probe and its routing. Even for the transitioned case a constructed
          // row silently drops whatever else the write touched. One read answers
          // both honestly: the stored row where there is one, the caller's own
          // view where there is not.
          return {
            resolution: 'recover',
            row: await readAgentRow(bus, agent.agentId, current ?? agent),
            arbitrated: true,
            joined,
          };
        }
      }
    }
    current = await readAgentRow(bus, agent.agentId, current ?? agent);
    const resolution = classifyJoinedRow(current);
    if (resolution !== undefined) return { resolution, row: current, arbitrated: false, joined };
  }

  throw new SessionStartError(
    'start-unresolved',
    `[session.start] agent ${agent.agentId} is still starting after joining and arbitrating its start`,
  );
}

/** Mutable result collections built while resolving the session's starting rows. */
interface StartingResolutionBookkeeping {
  readonly droppedAgentIds: Set<string>;
  readonly recoveringAgentIds: Set<string>;
  readonly deferredAgentIds: Set<string>;
  readonly arbitratedAgentIds: Set<string>;
  readonly refreshed: Map<string, MakaioSessionAgent>;
}

/**
 * Record one starting row's resolution for the send that observed it.
 * @param agentId - Identity whose starting row was resolved.
 * @param result - Resolution and authoritative row returned by the arbiter.
 * @param bookkeeping - Collections accumulated for the send.
 */
function recordStartingResolution(
  agentId: string,
  result: StartingAgentResolution,
  bookkeeping: StartingResolutionBookkeeping,
): void {
  const { resolution, row, arbitrated } = result;
  bookkeeping.droppedAgentIds.delete(agentId);
  bookkeeping.recoveringAgentIds.delete(agentId);
  bookkeeping.deferredAgentIds.delete(agentId);
  bookkeeping.arbitratedAgentIds.delete(agentId);
  if (resolution === 'drop') bookkeeping.droppedAgentIds.add(agentId);
  if (resolution === 'recover') {
    bookkeeping.recoveringAgentIds.add(agentId);
    if (arbitrated) bookkeeping.arbitratedAgentIds.add(agentId);
  }
  if (resolution === 'defer') bookkeeping.deferredAgentIds.add(agentId);
  if (row !== null) bookkeeping.refreshed.set(agentId, row);
}

/**
 * Record a session row's current authoritative non-starting state after a local join.
 * @param agentId - Identity whose non-starting row was refreshed.
 * @param row - Current stored row, or `null` when it has gone away.
 * @param bookkeeping - Collections accumulated for the send.
 */
function recordRefreshedSessionRow(
  agentId: string,
  row: MakaioSessionAgent | null,
  bookkeeping: StartingResolutionBookkeeping,
): void {
  switch (classifyJoinedRow(row)) {
    case 'drop':
      bookkeeping.recoveringAgentIds.delete(agentId);
      bookkeeping.deferredAgentIds.delete(agentId);
      bookkeeping.arbitratedAgentIds.delete(agentId);
      bookkeeping.droppedAgentIds.add(agentId);
      return;
    case 'use':
      // A row that became usable while another sibling was joined supersedes a
      // prior start resolution; probing it is now both safe and required.
      bookkeeping.droppedAgentIds.delete(agentId);
      bookkeeping.recoveringAgentIds.delete(agentId);
      bookkeeping.deferredAgentIds.delete(agentId);
      bookkeeping.arbitratedAgentIds.delete(agentId);
      if (row !== null) bookkeeping.refreshed.set(agentId, row);
      return;
    case 'recover':
      // Keep an existing starting-resolution provenance while its `dead` row
      // remains current; a dead sibling first seen outside that path still goes
      // through the ordinary liveness probe.
      bookkeeping.droppedAgentIds.delete(agentId);
      bookkeeping.deferredAgentIds.delete(agentId);
      if (row !== null) bookkeeping.refreshed.set(agentId, row);
      return;
    case undefined:
      throw new Error('[session.start] a starting sibling must be resolved before it is recorded');
  }
}

/**
 * Refresh every materialized session row until an entire pass waits for none.
 *
 * A join during the pass makes all rows read before it stale, so the next pass
 * begins again from storage. Each repeat follows a real local start that has
 * settled; {@link resolveStartingAgent} bounds that start's own observations.
 * The same contention limit bounds passes invalidated by fresh local starts.
 * @param bus - Bus the refresh reads and starting resolutions use.
 * @param session - Session whose materialized rows are refreshed.
 * @param bookkeeping - Collections accumulated for the send.
 */
async function refreshJoinedSessionRows(
  bus: IMakaioBus,
  session: IMakaioSession,
  bookkeeping: StartingResolutionBookkeeping,
): Promise<void> {
  let joinedRefreshPasses = 0;
  for (;;) {
    let joinedDuringPass = false;
    for (const agent of session.agents) {
      const row = await readAgentRow(bus, agent.agentId, agent);
      if (row?.status === 'starting') {
        const result = await resolveStartingAgent(bus, row);
        joinedDuringPass ||= result.joined;
        recordStartingResolution(agent.agentId, result, bookkeeping);
      } else {
        recordRefreshedSessionRow(agent.agentId, row, bookkeeping);
      }
    }
    if (!joinedDuringPass) return;
    joinedRefreshPasses += 1;
    if (joinedRefreshPasses > MAX_JOINED_REFRESH_PASSES) {
      throw new SessionStartError(
        'start-unresolved',
        `[session.start] session ${session.sessionId} did not stabilize after ${MAX_JOINED_REFRESH_PASSES} joined refresh passes`,
      );
    }
  }
}

/**
 * Apply the in-flight-start consumer rule to a session's agents.
 *
 * Runs *before* the liveness probe and before the fresh-start branch, and only
 * for agents whose stored status is `starting`. When this process waits for one
 * of those starts, every materialized row is re-read to a stable pass;
 * otherwise they cost nothing.
 * The ordering matters at both ends: probing a `starting` agent would find no
 * registered connector and walk into a second lifecycle for an identity that
 * already has one in flight, and an agent dropped here may be the session's last,
 * which must then start fresh rather than fail for having no targets.
 *
 * Dropped agents are removed from `session.agents` in place, and every agent that
 * survives is **replaced by the row this resolution read**, so every later step
 * of the send sees both the target set and the identities this resolution
 * produced. A local join also refreshes every materialized row: every one was
 * read before the wait, and the send probes and routes at all of their
 * identities afterwards. The second half matters as much as the first: a joined
 * attempt can bind an agent to a different adapter instance, and a send that
 * kept the pre-join snapshot would probe liveness and route at the instance the
 * lifecycle moved off.
 * @param bus - Bus the joins, reads and compare-and-swaps are issued on.
 * @param session - Session whose agents are resolved; its `agents` are filtered and refreshed in place.
 * @returns Which agents left the set, and which the send must recover.
 */
export async function resolveInFlightStarts(
  bus: IMakaioBus,
  session: IMakaioSession,
): Promise<InFlightStartResolution> {
  const droppedAgentIds = new Set<string>();
  const recoveringAgentIds = new Set<string>();
  const deferredAgentIds = new Set<string>();
  const arbitratedAgentIds = new Set<string>();
  const refreshed = new Map<string, MakaioSessionAgent>();
  const bookkeeping: StartingResolutionBookkeeping = {
    droppedAgentIds,
    recoveringAgentIds,
    deferredAgentIds,
    arbitratedAgentIds,
    refreshed,
  };
  let joinedStart = false;
  for (const agent of session.agents) {
    if (agent.status !== 'starting') continue;
    const result = await resolveStartingAgent(bus, agent);
    joinedStart ||= result.joined;
    recordStartingResolution(agent.agentId, result, bookkeeping);
  }

  // Waiting for a local start makes the whole materialized session snapshot
  // stale, including starting rows resolved before a later join. Refresh every
  // row before the send probes and recovers it; a row that is again `starting`
  // passes through the same resolver before it can reach either later step. A
  // row removed or disposed while waiting is no longer a target at all.
  if (joinedStart) {
    await refreshJoinedSessionRows(bus, session, bookkeeping);
  }

  // The designation is deliberately left alone. A session left with no agents
  // re-enters the fresh-start branch, which writes a new lead; one that still
  // has agents but lost the one it named has a stale designation either way, and
  // target resolution says so plainly.
  if (droppedAgentIds.size > 0 || refreshed.size > 0) {
    session.agents = session.agents
      .filter((agent) => !droppedAgentIds.has(agent.agentId))
      .map((agent) => refreshed.get(agent.agentId) ?? agent);
  }
  return { droppedAgentIds, recoveringAgentIds, deferredAgentIds, arbitratedAgentIds };
}

/**
 * How many times a joining consumer may re-enter the exclusive seam.
 *
 * One. A joined attempt that resolved normally and left the row `dead` gave up
 * the agent — it was refused, it deferred, or it lost its own arbitration — and
 * this consumer has not asked the question for itself yet, so it asks once. A
 * second re-entry would be this consumer joining a *third* attempt, which is
 * contention it cannot resolve by trying harder.
 */
const MAX_JOIN_REENTRIES = 1;

/**
 * How a run-or-joined recovery ended.
 *
 * `joined` is deliberately not folded into `rehydrated`. A joiner dispatched
 * nothing and settled nothing: all it knows is what the stored row says, so it
 * cannot honestly report whether the connector behind that row resumed the
 * provider session natively. Naming the two apart keeps the one claim a joiner
 * *can* make — this agent is usable — separate from the ones only the attempt
 * that ran can make.
 */
export type ExclusiveRehydrateOutcome =
  | ReservedRehydrateOutcome
  | {
      readonly kind: 'joined';
      /** The agent, re-stamped with the instance the joined attempt bound it to. */
      readonly agent: MakaioSessionAgent;
    };

/** An outcome decided before an exclusive recovery attempt can reserve or dispatch. */
export type EarlyRehydrateOutcome = Extract<
  ReservedRehydrateOutcome,
  { kind: 'deferred' | 'lost' | 'refused' | 'stale-plan' }
>;

/**
 * Build the exact request an exclusive recovery attempt may execute.
 *
 * The factory is invoked only by the callback that won the in-flight-start
 * seam. A joiner must not read a recovery snapshot, resolve an adapter
 * incarnation or inspect a holder generation: all of those facts can change
 * while it waits for another attempt.
 */
export type ReservedRehydrateAttemptFactory = () => Promise<ReservedRehydrateRequest | EarlyRehydrateOutcome>;

/**
 * Whether an attempt factory produced a dispatchable reserved-rehydrate request.
 * @param value - Factory result to classify.
 * @returns `true` when the result carries a reserved-rehydrate request.
 */
function isReservedRehydrateRequest(
  value: ReservedRehydrateRequest | EarlyRehydrateOutcome,
): value is ReservedRehydrateRequest {
  return 'resumeProviderSessionId' in value;
}

/**
 * Recover one agent under the exclusive-start seam — run it, or consume the
 * attempt that is already running.
 *
 * **A joined attempt that resolved normally is not a success.** It is the
 * failure this seam is most likely to hide: `occupied`, `deferred`, a refused
 * reservation and a lost arbitration are all *normal resolutions* of the
 * attempt, and a joiner that read only the absence of a rejection would report
 * its own recovery as complete and hand the caller an agent with no connector
 * behind it (I23a/b). So the row is re-read and classified by the same table
 * every other join in this codebase applies, and only `idle`/`active` is usable.
 *
 * A `dead` row is the one verdict a joiner may act on rather than report: the
 * attempt it joined answered for *its* inputs, not for this consumer's, so this
 * consumer enters the seam once itself and gets an authoritative outcome —
 * including the `deferred` it must be told about. `starting` is unresolved by
 * definition, and a gone or `disposed` row is unavailable.
 * @param bus - Bus every step is issued on.
 * @param agent - Agent identity the exclusive-start seam coordinates.
 * @param createAttempt - Builds a fresh recovery request only after this call wins the seam.
 * @returns How the recovery ended, or `undefined` when a self-run attempt recorded nothing.
 * @throws A {@link SessionStartError} when a joined attempt failed or nothing resolved.
 */
export async function runOrJoinReservedRehydrate(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  createAttempt: ReservedRehydrateAttemptFactory,
): Promise<ExclusiveRehydrateOutcome | undefined> {
  for (let reentry = 0; reentry <= MAX_JOIN_REENTRIES; reentry += 1) {
    let outcome: ReservedRehydrateOutcome | undefined;
    const start = runExclusiveStart(agent.agentId, async () => {
      const attempt = await createAttempt();
      outcome = isReservedRehydrateRequest(attempt) ? await runReservedRehydrate(bus, attempt) : attempt;
      return outcome.kind === 'rehydrated' ? 'connected' : 'no-connector';
    });
    if (!start.joined) {
      // This call owns the attempt, so its failure is already this call's own
      // and propagates unwrapped.
      await start.settled;
      return outcome;
    }

    const joined = await consumeJoinedAttempt(bus, agent, start.settled);
    if (joined !== 'retry') return joined;
  }

  throw new SessionStartError(
    'start-unresolved',
    `[session.start] recovery of agent ${agent.agentId} did not resolve after joining and re-entering its start`,
  );
}

/**
 * Read what an attempt this call joined left behind.
 *
 * The rejection is read before the row, because it is this process's own and
 * outranks an advisory status write; the row then classifies what a *successful*
 * attempt produced.
 * @param bus - Bus the re-read is issued on.
 * @param agent - Agent whose start was joined; re-stamped with the instance the row names.
 * @param settled - The joined attempt, as the seam handed it back.
 * @returns The outcome to report, or `retry` when this consumer must run the recovery itself.
 * @throws A {@link SessionStartError} when the joined attempt rejected.
 */
async function consumeJoinedAttempt(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  settled: Promise<StartAttemptOutcome>,
): Promise<ExclusiveRehydrateOutcome | 'retry'> {
  let joinedFailure: { readonly error: unknown } | undefined;
  const attempt = await settled.catch((error: unknown) => {
    joinedFailure = { error };
    return 'no-connector' as const;
  });
  if (joinedFailure !== undefined) {
    throw new SessionStartError(
      'start-failed',
      `[session.start] recovery of agent ${agent.agentId} was joined from another attempt, which failed`,
      joinedFailure.error,
    );
  }
  // **The row is read before anything is decided, and the caller's snapshot is
  // refreshed from it.** The attempt this call joined ran to completion, so every
  // field of the pre-join snapshot is a statement about a row somebody else has
  // since written — and the one this function's own callers act on hardest is
  // `status`: a re-entry claims the recovery by compare-and-swap *against the
  // status it believes it is leaving*, so a stale snapshot claims from a state
  // the row left and loses a claim it should have won. That is not a peer
  // arbitrating; it is this call arguing with the attempt it waited for.
  //
  // Refreshed in place because the caller's object *is* the session's agent: the
  // send that owns it keeps routing at it after this returns. And refreshed
  // whole, not field by field — the attempt is a *rehydrate*, which persisted the
  // cwd and the model it was dispatched with, the provider session its connector
  // confirmed, and the instance it bound the agent to. A joiner that copied one
  // of those and kept its snapshot for the rest would hand the caller an identity
  // that never existed, and the consumers act on all of it: the cwd and model
  // decide whether a connector swap is issued, and the next recovery's rollback
  // target is read off the status.
  const row = await readAgentRow(bus, agent.agentId, agent);
  if (row !== null) Object.assign(agent, row);

  // The attempt's own verdict, after the refresh but ahead of the
  // classification, and outranking it. A modeled non-success — a recovery that
  // deferred, a reservation that was refused, a start that lost its designation
  // race — is a *resolution*, so it looks exactly like success to anyone watching
  // only for a rejection. The row such an attempt leaves behind may be the row it
  // found, whose `idle` reads `use` while no connector was ever built. This
  // consumer therefore asks the question for itself, from the refreshed snapshot.
  if (attempt === 'no-connector') return 'retry';

  switch (classifyJoinedRow(row)) {
    case 'use':
      return { kind: 'joined', agent };
    case 'drop':
      return { kind: 'refused', outcome: row === null ? 'not-found' : 'agent-disposed' };
    case 'recover':
      return 'retry';
    case 'defer':
      // `classifyJoinedRow` reads only durable lifecycle statuses, none of
      // which carries ownership deferral. If that contract grows, joining a
      // start must gain an explicit ownership decision rather than silently
      // retrying it.
      throw new Error('[session.start] joined-row classification returned an unsupported ownership deferral');
    case undefined:
      // Still `starting`: neither the join nor the row resolved it, and the
      // bounded re-entry decides whether that is final.
      return 'retry';
  }
}

/** What a send's lazy recovery of one dead agent left it with. */
export interface LazyRecoveryResult {
  /**
   * Whether this runtime may not drive the agent at all.
   *
   * `true` means no connector was built and none may be, for one of the two
   * reasons that are the same statement one step apart: the reservation found
   * the agent's provider session held by a generation this runtime does not own
   * (I23a), or this runtime cannot derive the adapter instance for the machine
   * the recovery acts under, which is the ownership authority's own
   * `machine-identity-unavailable` a round trip earlier. Both are acts this
   * runtime *may not perform*, not acts that failed, so the send drops the agent
   * rather than retrying.
   */
  readonly deferred: boolean;
}

/**
 * Recover one dead agent for a send — reserved, exclusive per agent identity.
 *
 * The seam is what keeps two concurrent sends onto the same dead agent from
 * opening two lifecycles for it: the second joins the first instead of
 * dispatching a rehydrate that would race the connector the first is building.
 * Inside it, the shared reserved rehydrate does the durable work, so this path
 * takes ownership of the provider session before it speaks to it and addresses
 * a **freshly resolved** adapter instance rather than the persisted one, which
 * goes stale across a runtime restart.
 *
 * **A joined attempt's rejection fails this send too.** It is tempting to treat
 * it as somebody else's problem — it is another send's attempt, and it reports
 * to its own caller — but routing anyway would admit a turn and persist a user
 * message against an agent whose connector was never built. The same reasoning
 * covers the attempt that *resolved* without building one, which is why the join
 * is consumed through the shared seam rather than taken at its word.
 * **And it addresses an instance the machine it acts under can account for.**
 * Everything this recovery does durably — the reservation, and the settlement on
 * the key the connector confirms — names `machineId` *and* the instance
 * together. Falling back to the agent's persisted instance when the machine's
 * own cannot be derived would file those acts under a pair no other actor
 * computes: a key that collides with nothing protects nothing, and the peer it
 * was supposed to exclude claims the same provider session beside it. So an
 * unresolvable instance is a deferral, not a fallback.
 * @param bus - Bus the dispatch and the join are issued on.
 * @param agent - Dead agent whose connector is being rebuilt.
 * @param request - Resume target for this recovery, and the machine identity to act under.
 * @returns Whether the agent must leave this send's target set.
 * @throws A {@link SessionStartError} when the recovery failed rather than deferred.
 */
export async function recoverDeadAgentExclusively(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  request: { readonly resumeProviderSessionId: string | null; readonly machineId?: string },
): Promise<LazyRecoveryResult> {
  const { agentId } = agent;
  if (request.resumeProviderSessionId === null) {
    const outcome = await runOrJoinReservedRehydrate(bus, agent, async () => {
      const snapshot = await readRecoveryPlanningSnapshot(bus, agentId);
      if (snapshot === null || !recoverySnapshotIsClaimable(snapshot)) return { kind: 'lost' };
      Object.assign(agent, snapshot.agent);
      const instance = toMachineScopedAdapterInstance(
        await resolveOwnedAdapterInstance(bus, {
          adapterName: agent.adapterName,
          storedAdapterId: agent.adapterId,
          ...(request.machineId !== undefined && { machineId: request.machineId }),
        }),
      );
      if (instance === undefined) return { kind: 'deferred', reason: 'machine-identity-unavailable' };
      return {
        agent,
        sessionId: agent.sessionId,
        instance,
        resumeProviderSessionId: null,
        recoveryGuard: { ...snapshot.guard, ownerGeneration: null },
      };
    });
    return classifyRecoveryOutcome(agentId, outcome);
  }

  for (let replan = 0; replan <= MAX_RECOVERY_REPLANS; replan += 1) {
    const outcome = await runOrJoinReservedRehydrate(bus, agent, async () => {
      const snapshot = await readRecoveryPlanningSnapshot(bus, agentId);
      if (snapshot === null || !recoverySnapshotIsClaimable(snapshot)) return { kind: 'lost' };
      const resumeProviderSessionId = recoveryProviderSessionId(snapshot);
      if (resumeProviderSessionId === null) return { kind: 'stale-plan' };
      Object.assign(agent, snapshot.agent);
      const instance = toMachineScopedAdapterInstance(
        await resolveOwnedAdapterInstance(bus, {
          adapterName: agent.adapterName,
          storedAdapterId: agent.adapterId,
          ...(request.machineId !== undefined && { machineId: request.machineId }),
        }),
      );
      if (instance === undefined) return { kind: 'deferred', reason: 'machine-identity-unavailable' };
      const recoveryGuard = await buildRecoveryReservationGuard(bus, snapshot, instance, resumeProviderSessionId);
      return { agent, sessionId: agent.sessionId, instance, resumeProviderSessionId, recoveryGuard };
    });
    if (outcome?.kind === 'stale-plan' && replan < MAX_RECOVERY_REPLANS) continue;
    return classifyRecoveryOutcome(agentId, outcome);
  }

  return classifyRecoveryOutcome(agentId, { kind: 'stale-plan' });
}

/**
 * Turn this send's own recovery outcome into what the send does next.
 *
 * Only `deferred` is a decision the send may absorb; every other non-success is
 * a failure the caller must see, because the alternative is routing to an agent
 * with no connector behind it.
 * @param agentId - Agent that was recovered.
 * @param outcome - What the recovery answered.
 * @returns Whether the agent must leave this send's target set.
 * @throws A {@link SessionStartError} for every outcome that is not a recovery or a deferral.
 */
function classifyRecoveryOutcome(agentId: string, outcome: ExclusiveRehydrateOutcome | undefined): LazyRecoveryResult {
  switch (outcome?.kind) {
    case 'rehydrated':
    // A joined attempt left a usable row behind, which is all this send needs:
    // whatever it decided about ownership was reported to its own caller.
    case 'joined':
      return { deferred: false };
    case 'deferred':
      return { deferred: true };
    // Exhaustive by type rather than by enumeration: the shared factory accepts
    // exactly the remaining members, so a new outcome stops compiling here
    // instead of silently becoming a start failure.
    default:
      throw failedRehydrateError(agentId, outcome);
  }
}
