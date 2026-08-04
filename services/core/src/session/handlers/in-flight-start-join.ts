import type { IMakaioBus } from '@makaio/bus-core';
import type { IMakaioSession, MakaioSessionAgent } from '@makaio/contracts';
import { AdapterSubjects } from '@makaio/contracts';
import { peekInFlightStart, runExclusiveStart } from '../ownership/index.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
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

/** What a consumer does with an agent whose start it joined or arbitrated. */
export type StartResolution =
  /** The agent is usable as it stands. */
  | 'use'
  /** The agent is not part of this send: the row is gone, or terminal. */
  | 'drop'
  /** The agent needs the ordinary fresh-with-history recovery. */
  | 'recover';

/** How a send's target set changed once every in-flight start was resolved. */
export interface InFlightStartResolution {
  /** Agents that left the session's target set — deleted or `disposed` rows. */
  readonly droppedAgentIds: ReadonlySet<string>;
  /** Agents this send must recover before using. */
  readonly recoveringAgentIds: ReadonlySet<string>;
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
 * **That rests on the attempt writing the row when it fails**, which is a
 * property of the fresh-start path (delete before dispatch, compare-and-swap to
 * `dead` after one) and not of every attempt the seam can hold. A rehydrate
 * writes no status at all, so a failed one leaves the row untouched and its
 * caller must observe the rejection before reaching this table — see the restart
 * path's join.
 *
 * Exported so both consumers classify a *successful* joined attempt by one
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
 * Resolve one agent whose stored status is `starting`.
 *
 * Two arbiters, in this order. The process-local registry makes the
 * same-process case exact: an entry means this runtime is driving the attempt,
 * so the send joins it rather than racing it. No entry means the attempt belongs
 * to a process that is gone or to a live peer, neither of which the registry can
 * see — so the send claims the recovery through a status compare-and-swap
 * instead, which the peer's own completion will then lose against and report.
 * @param bus - Bus the reads and the compare-and-swap are issued on.
 * @param agent - The agent as the session row carries it.
 * @returns What this send does with the agent.
 */
async function resolveStartingAgent(bus: IMakaioBus, agent: MakaioSessionAgent): Promise<StartResolution> {
  let current: MakaioSessionAgent | null = agent;
  for (let observation = 0; observation < MAX_STARTING_OBSERVATIONS; observation += 1) {
    const inFlight = peekInFlightStart(agent.agentId);
    if (inFlight !== undefined) {
      // The rejection says only that the attempt is over; the row says what
      // happened.
      await inFlight.settled.catch(() => undefined);
    } else {
      const claimed = await bus.requestOptional(AgentStorageSubjects.updateStatus, {
        agentId: agent.agentId,
        status: 'dead',
        expectedStatus: ['starting'],
      });
      if (!claimed.handled || claimed.data.transitioned) return 'recover';
    }
    current = await readAgentRow(bus, agent.agentId, current ?? agent);
    const resolution = classifyJoinedRow(current);
    if (resolution !== undefined) return resolution;
  }

  throw new SessionStartError(
    'start-unresolved',
    `[session.start] agent ${agent.agentId} is still starting after joining and arbitrating its start`,
  );
}

/**
 * Apply the in-flight-start consumer rule to a session's agents.
 *
 * Runs *before* the liveness probe and before the fresh-start branch, and only
 * for agents whose stored status is `starting` — every other row costs nothing.
 * The ordering matters at both ends: probing a `starting` agent would find no
 * registered connector and walk into a second lifecycle for an identity that
 * already has one in flight, and an agent dropped here may be the session's last,
 * which must then start fresh rather than fail for having no targets.
 *
 * Dropped agents are removed from `session.agents` in place, so every later step
 * of the send sees the target set this resolution produced.
 * @param bus - Bus the joins, reads and compare-and-swaps are issued on.
 * @param session - Session whose agents are resolved; its `agents` are filtered in place.
 * @returns Which agents left the set, and which the send must recover.
 */
export async function resolveInFlightStarts(
  bus: IMakaioBus,
  session: IMakaioSession,
): Promise<InFlightStartResolution> {
  const droppedAgentIds = new Set<string>();
  const recoveringAgentIds = new Set<string>();
  for (const agent of session.agents) {
    if (agent.status !== 'starting') continue;
    const resolution = await resolveStartingAgent(bus, agent);
    if (resolution === 'drop') droppedAgentIds.add(agent.agentId);
    if (resolution === 'recover') recoveringAgentIds.add(agent.agentId);
  }

  // The designation is deliberately left alone. A session left with no agents
  // re-enters the fresh-start branch, which writes a new lead; one that still
  // has agents but lost the one it named has a stale designation either way, and
  // target resolution says so plainly.
  if (droppedAgentIds.size > 0) {
    session.agents = session.agents.filter((agent) => !droppedAgentIds.has(agent.agentId));
  }
  return { droppedAgentIds, recoveringAgentIds };
}

/**
 * Rehydrate one dead agent, exclusively per agent identity.
 *
 * The seam is what keeps two concurrent sends onto the same dead agent from
 * opening two lifecycles for it: the second joins the first instead of
 * dispatching a rehydrate that would race the connector the first is building.
 *
 * **A joined attempt's rejection fails this send too.** It is tempting to
 * treat it as somebody else's problem — it is another send's attempt, and it
 * reports to its own caller — but the row cannot stand in for it here: a
 * rehydrate writes no status when it fails, so the agent this send is about to
 * route to looks exactly as it did before, while the connector it needs was
 * never built. Routing anyway would admit a turn and persist a user message
 * against an agent that cannot answer. The restart path draws the same line
 * for the same reason; this is that rule on the send side.
 * @param bus - Bus the dispatch and the join are issued on.
 * @param agent - Dead agent whose connector is being rebuilt.
 * @param resumeAdapterSessionId - Provider session to resume, when the plan names one.
 * @throws A {@link SessionStartError} when the attempt this send joined failed.
 */
export async function recoverDeadAgentExclusively(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
  resumeAdapterSessionId: string | undefined,
): Promise<void> {
  const start = runExclusiveStart(agent.agentId, async () => {
    await bus.requestOptional(AdapterSubjects.rehydrateAgent, {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      ...(resumeAdapterSessionId !== undefined && { resumeAdapterSessionId }),
    });
  });
  if (!start.joined) {
    // This send owns the attempt, so its failure is already this send's own
    // and propagates unwrapped.
    await start.settled;
    return;
  }

  let joinedFailure: { readonly error: unknown } | undefined;
  await start.settled.catch((error: unknown) => {
    joinedFailure = { error };
  });
  if (joinedFailure === undefined) return;
  throw new SessionStartError(
    'start-failed',
    `[session.start] recovery of agent ${agent.agentId} was joined from another send, which failed`,
    joinedFailure.error,
  );
}
