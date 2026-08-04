import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type SessionOwnershipSettleMovementServiceResult } from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import {
  abandonDispatchedStart,
  applySettlementOutcome,
  stopStartedConnector,
  StartClaimTokens,
  type StartCleanupPolicy,
} from './lead-start-cleanup.js';
import { SessionStartError } from './session-start-error.js';

/**
 * One dispatched caller-owned start, as its settlement and commit need it.
 *
 * The two paths that own the agent row they start — a fresh lead start and a
 * reserved attach — have the same phase table: the caller writes `starting`
 * before the dispatch, the ownership seam writes the currency, and the caller
 * compare-and-swaps `starting → idle` at the end. Only the payload that got
 * them there differs, so the tail is written once.
 */
export interface CallerOwnedStart {
  /** Session the agent was started into. */
  readonly sessionId: string;
  /** Agent the start was for; the row this attempt owns. */
  readonly agentId: string;
  /** Live adapter instance the connector lives on. */
  readonly adapterId: string;
  /** Adapter type name every ownership act names. */
  readonly adapterName: string;
  /** Provider config to stamp on the agent's runtime row. */
  readonly providerConfigId?: string;
  /** Machine identity the settlement acts under, or `undefined` for the authority's own. */
  readonly machineId?: string;
  /** What a cleanup may write on this start's behalf. */
  readonly policy: StartCleanupPolicy;
  /** The generations this attempt is answerable for. */
  readonly claimTokens: StartClaimTokens;
  /**
   * Generation this attempt minted for its own settlement, when it minted one.
   *
   * Supplied by a caller that seeded the same token into
   * {@link CallerOwnedStart.claimTokens} before settling, so a settlement whose
   * transaction commits and whose response is then lost still names a successor
   * the failure path can give back. Omitted, the authority mints as before.
   */
  readonly settlementClaimToken?: string;
}

/**
 * How a caller-owned `starting → idle` commit ended — the binding I21′ table.
 *
 * `agents.status` is a single slot with no owner identity, so a refused
 * transition cannot say *who* refused it. A peer applying the in-flight consumer
 * rule compare-and-swaps `starting → dead` to claim a recovery it will then be
 * refused by the reservation, and an unreserved attempt joining the same agent
 * may write `idle` first: neither is evidence that this attempt lost anything,
 * and stopping a healthy connector on the strength of either is the arbitration
 * I21′ withdrew.
 *
 * Removal is the one exception, and it is not status arbitration: `disposed` is
 * terminal, owner-independent and irreversible, so reading it cannot be raced.
 * A removal landing between the settlement and the commit releases the agent's
 * claims and leaves a live connector with no generation, and the re-read on the
 * uncommon refusal branch is what catches it.
 *
 * Shared by both caller-owned status writers — this module's tail and the
 * reserved rehydrate's — because a second copy of a three-way table is a second
 * chance to state one of its rows differently.
 */
export type CallerOwnedCommit =
  /** This attempt wrote the transition, or there is no agent storage to write it in. */
  | 'committed'
  /** Something else holds the slot, and it says nothing about ownership. */
  | 'no-op'
  /** The row was removed under this attempt: the connector is an orphan. */
  | 'lost';

/**
 * Compare-and-swap a caller-owned start to `idle`, and read the refusal rather
 * than assume it.
 *
 * `dead` is in the expectation so an owner whose row a peer stomped restores it;
 * `disposed` is excluded by the terminal rule and can never be revived.
 * @param bus - Bus the commit and the re-read are issued on.
 * @param agentId - Agent whose start is being closed.
 * @returns Which row of the I21′ table this commit landed on.
 */
export async function readCallerOwnedCommit(bus: IMakaioBus, agentId: string): Promise<CallerOwnedCommit> {
  const committed = await bus.requestOptional(AgentStorageSubjects.updateStatus, {
    agentId,
    status: 'idle',
    expectedStatus: ['starting', 'dead'],
  });
  // Unhandled means no agent storage in this host, so there is no row for a peer
  // to have taken and nothing to arbitrate.
  if (!committed.handled || committed.data.transitioned) return 'committed';
  // `success: false` is the row being gone entirely — a removal that also
  // deleted it, which needs no second read to classify.
  if (!committed.data.success) return 'lost';
  return (await agentWasRemoved(bus, agentId)) ? 'lost' : 'no-op';
}

/**
 * Read whether the agent row was removed while this attempt ran.
 *
 * Read by both classifications a dispatched caller-owned attempt can reach: the
 * refused commit above, and the shared teardown of a step that threw. A removal
 * is the one post-dispatch failure with a precise name, and every path that
 * cannot see it reports it as an unresolved settlement.
 * @param bus - Bus the read is issued on.
 * @param agentId - Agent to re-read.
 * @returns `true` when the row is gone or `disposed`.
 */
async function agentWasRemoved(bus: IMakaioBus, agentId: string): Promise<boolean> {
  const stored = await bus.requestOptional(AgentStorageSubjects.get, { agentId });
  if (!stored.handled) return false;
  const row = stored.data.agent;
  return row === null || row.status === 'disposed';
}

/**
 * Complete a dispatched caller-owned start: settle what it confirmed, then
 * close its own status transition.
 *
 * **Everything from here on runs under a guard, and that is the point.** The
 * connector is live by now, so a step that throws — a storage transport failure,
 * a shutdown mid-flight, an absent settlement authority — leaves an agent whose
 * row says `starting`, whose generation is `held` and whose caller has no handle
 * left to retire it with. The two guarded regions retire exactly what the
 * attempt took, once.
 *
 * {@link applySettlementOutcome} deliberately sits **outside** both: it is the
 * one step that cleans and throws for itself, and a `try` spanning it would
 * clean a second time and relabel a precisely classified ownership refusal as an
 * unresolved settlement (§8.2).
 * @param bus - Bus every step is issued on.
 * @param start - The dispatched start being completed.
 * @param providerSessionId - Provider session the adapter reported, when it did.
 * @throws A {@link SessionStartError} when the completion failed or the row was removed under it.
 */
export async function completeCallerOwnedStart(
  bus: IMakaioBus,
  start: CallerOwnedStart,
  providerSessionId: string | undefined,
): Promise<void> {
  let settled: SessionOwnershipSettleMovementServiceResult | undefined;
  try {
    settled = await settleCallerOwnedStart(bus, start, providerSessionId);
  } catch (error) {
    throw await failCompletedStart(bus, start, error);
  }
  if (settled !== undefined) {
    await applySettlementOutcome(bus, start.adapterId, start.agentId, settled, start.policy, start.claimTokens);
  }

  // **After the settlement, and that ordering is the point.** This write is the
  // agent row's origin identity — where the conversation started from — and it
  // is bookkeeping: nothing about ownership depends on it. It used to run
  // first, which put a fallible write in front of the one act that claims the
  // key the connector is live on. A throw there left the confirmed provider
  // session claimed by nobody while a connector spoke to it, and the failure
  // path had no generation to give back, because none had been created. Settled
  // first, the same throw retires a real generation as `abandoned`, which is
  // what every other post-dispatch failure does and what protects a provider
  // session nobody has proven closed.
  let commit: CallerOwnedCommit;
  try {
    await persistStartOrigin(bus, start, providerSessionId);
    commit = await readCallerOwnedCommit(bus, start.agentId);
  } catch (error) {
    throw await failCompletedStart(bus, start, error);
  }
  if (commit !== 'lost') return;

  await abandonDispatchedStart(bus, start.agentId, start.policy, start.claimTokens);
  await stopStartedConnector(bus, start.adapterId, start.agentId);
  throw new SessionStartError(
    'agent-unavailable',
    `[session.start] agent ${start.agentId} was removed while its start was completing`,
  );
}

/**
 * Settle the provider session the adapter reported.
 *
 * The first thing this start does with a live connector, because it is the act
 * that claims the key that connector is speaking to. The origin identity is
 * written separately and afterwards — see {@link persistStartOrigin} — since the
 * ownership seam is the only writer of where the conversation currently lives
 * and the row's own column only records where it began.
 *
 * A start that returned no provider session (an idle fork start) has nothing to
 * settle — the movement observer settles it when the provider confirms — and
 * answers `undefined` so the status transition still runs.
 * @param bus - Bus the settlement is issued on.
 * @param start - The dispatched start being completed.
 * @param providerSessionId - Provider session the adapter reported, when it did.
 * @returns What the authority answered, or `undefined` when there was nothing to settle.
 */
async function settleCallerOwnedStart(
  bus: IMakaioBus,
  start: CallerOwnedStart,
  providerSessionId: string | undefined,
): Promise<SessionOwnershipSettleMovementServiceResult | undefined> {
  const { agentId, adapterId } = start;
  if (providerSessionId === undefined) return undefined;

  // A **hard** request, exactly as the reservation this start already holds: the
  // same registration installs both subjects, so a start that reserved and then
  // found no settlement authority is impossible rather than degraded. Reaching
  // here without one would mean a live connector whose currency nobody writes.
  return bus.request(SessionSubjects.ownership.settleMovement, {
    sessionId: start.sessionId,
    agentId,
    adapterId,
    adapterName: start.adapterName,
    movement: { confirmed: true, providerSessionId },
    ...(start.settlementClaimToken !== undefined && { claimToken: start.settlementClaimToken }),
    ...(start.machineId !== undefined && { machineId: start.machineId }),
  });
}

/**
 * Record where this agent's conversation began.
 *
 * The row's `adapterSessionId` is origin, not currency: it names the provider
 * session the agent started *from* and never moves, while where the
 * conversation now lives is the ownership seam's to write. Purely a record, so
 * it runs behind the settlement rather than in front of it.
 *
 * **A hard request whose answer is read, and both failure forms are failures.**
 * The column is write-once, so a silently dropped write is a start that
 * permanently misreports where its conversation began — and every later native
 * resume reads that column. An unhandled subject is not the lightweight host it
 * would be elsewhere: this start only got here because its *reservation*
 * succeeded, and the claim transaction answers `not-found` for an agent row it
 * cannot read, while the storage package registers the ownership and agent
 * handlers as one block. A reservation that succeeded is therefore proof that
 * agent storage answers, and a host where it then does not is inconsistent
 * rather than lightweight.
 * @param bus - Bus the write is issued on.
 * @param start - The dispatched start being completed.
 * @param providerSessionId - Provider session the adapter reported, when it did.
 * @throws When the row cannot be updated, in either failure form.
 */
async function persistStartOrigin(
  bus: IMakaioBus,
  start: CallerOwnedStart,
  providerSessionId: string | undefined,
): Promise<void> {
  const { agentId, providerConfigId } = start;
  if (providerSessionId === undefined && providerConfigId === undefined) return;
  const written = await bus.request(AgentStorageSubjects.updateRuntime, {
    agentId,
    ...(providerSessionId !== undefined && { adapterSessionId: providerSessionId }),
    ...(providerConfigId !== undefined && { providerConfigId }),
  });
  if (!written.success) {
    throw new Error(`[session.start] recording the origin session of agent ${agentId} was refused`);
  }
}

/**
 * Unwind a completion step that threw.
 * @param bus - Bus the cleanup is issued on.
 * @param start - The dispatched start being unwound.
 * @param cause - Whatever the failing step threw.
 * @returns The error the caller reports, so the call site stays a single `throw`.
 */
async function failCompletedStart(
  bus: IMakaioBus,
  start: CallerOwnedStart,
  cause: unknown,
): Promise<SessionStartError> {
  return failDispatchedStart(
    bus,
    {
      adapterId: start.adapterId,
      agentId: start.agentId,
      attemptKind: 'start',
      policy: start.policy,
      claimTokens: start.claimTokens,
    },
    cause,
  );
}

/** One dispatched caller-owned attempt, as its teardown needs it. */
export interface DispatchedStartTeardown {
  /** Adapter instance the connector lives on. */
  readonly adapterId: string;
  /** Agent whose dispatched attempt is unwound. */
  readonly agentId: string;
  /** What this attempt was; it is named in both sentences this teardown produces. */
  readonly attemptKind: 'start' | 'rehydrate';
  /** What the cleanup may write on this attempt's behalf. */
  readonly policy: StartCleanupPolicy;
  /** The generations this attempt is answerable for. */
  readonly claimTokens: StartClaimTokens;
}

/**
 * Unwind a dispatched caller-owned attempt that threw — the caller-owned twin
 * of §8.2's last row, for every path that has one.
 *
 * The connector is stopped, unlike the *unresolved settlement* the outcome table
 * classifies: this failure is a throw, so nothing is known about how far it got,
 * and the row must not be left `starting` with no process intending to finish
 * it. Runs exactly once per attempt, because the only step that cleans for
 * itself is kept outside the guards that call this.
 *
 * **And it reads the row once before it names the failure.** A removal is the
 * one post-dispatch failure with a name of its own, and it arrives here as an
 * ordinary refusal — the row is gone, so the write that named it fails like any
 * other. Without the re-read, "the agent was removed" is reported as "the
 * settlement did not resolve", which is what a consumer branches on. Shared by
 * the fresh start, the attach and the rehydrate for the same reason their I21′
 * commit table is shared: a second copy of a classification is a second chance
 * to state one of its rows differently, and the three had already drifted.
 * @param bus - Bus the cleanup and the re-read are issued on.
 * @param teardown - The dispatched attempt being unwound.
 * @param cause - Whatever the failing step threw.
 * @returns The error the caller reports, so the call site stays a single `throw`.
 */
export async function failDispatchedStart(
  bus: IMakaioBus,
  teardown: DispatchedStartTeardown,
  cause: unknown,
): Promise<SessionStartError> {
  const { adapterId, agentId, attemptKind, policy, claimTokens } = teardown;
  await abandonDispatchedStart(bus, agentId, policy, claimTokens);
  await stopStartedConnector(bus, adapterId, agentId);
  if (await agentWasRemoved(bus, agentId)) {
    return new SessionStartError(
      'agent-unavailable',
      `[session.start] agent ${agentId} was removed while its ${attemptKind} was completing`,
      cause,
    );
  }
  return new SessionStartError(
    'settlement-unresolved',
    `[session.start] completing the ${attemptKind} of agent ${agentId} did not resolve`,
    cause,
  );
}
