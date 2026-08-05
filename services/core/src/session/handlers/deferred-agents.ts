import type { IMakaioSession, MakaioSessionAgent } from '@makaio/contracts';
import { SessionStartError } from './session-start-error.js';

/**
 * Which of `sendMessage`'s three target forms a send used.
 *
 * They degrade differently when an agent turns out to be held by a foreign
 * generation, and the difference is not cosmetic: a caller that named its
 * agents asked for *those* agents, so silently substituting a new one would
 * answer a question nobody asked.
 */
export type SendTargetForm =
  /** No targets named — the session's lead, and nothing else. */
  | 'lead-default'
  /** A broadcast to whatever the session currently has. */
  | 'all'
  /** The caller named the agents itself. */
  | 'explicit';

/**
 * Classify a send by the target spec it carried.
 * @param targetSpec - The request's `agentIds`, as the schema models it.
 * @returns Which form this send is.
 */
export function resolveSendTargetForm(targetSpec: readonly string[] | 'all' | undefined): SendTargetForm {
  if (targetSpec === undefined) return 'lead-default';
  return targetSpec === 'all' ? 'all' : 'explicit';
}

/**
 * Remove agents this runtime may not drive from the session and the send.
 *
 * **This has to happen before admission and routing, not after.** The targets
 * are materialised before the liveness-and-recovery pass, so folding a deferral
 * into a set afterwards changes no snapshot, no admission decision and no
 * routing table — the message would still be delivered to an agent storage has
 * just said belongs to another generation, which is I23a defeated by
 * bookkeeping.
 *
 * The session's own agent list is filtered too, so a deferral that empties the
 * session reaches the fresh-start branch exactly as a dropped in-flight start
 * does.
 * @param session - Session being sent to; its `agents` are filtered in place.
 * @param targetAgents - Targets this send materialised.
 * @param deferredAgentIds - Agents held by a generation this runtime does not own.
 * @returns The targets that survive, in their original order.
 */
export function dropDeferredAgents(
  session: IMakaioSession,
  targetAgents: readonly MakaioSessionAgent[],
  deferredAgentIds: ReadonlySet<string>,
): MakaioSessionAgent[] {
  if (deferredAgentIds.size === 0) return [...targetAgents];
  session.agents = session.agents.filter((agent) => !deferredAgentIds.has(agent.agentId));
  return targetAgents.filter((agent) => !deferredAgentIds.has(agent.agentId));
}

/**
 * Refuse a send whose every target is held elsewhere.
 *
 * `agent-unavailable` is reused rather than invented: it already means "this
 * runtime may not act for this agent". A broadcast with no recipient is not a
 * delivery, and a caller that named its agents is owed the failure rather than
 * a substitute.
 *
 * **Exported for the send pipelines a product composes itself.** *Whether* a
 * total deferral is a refusal is a product decision — this framework's
 * orchestrator and a product's may guard it differently — but the refusal it
 * raises is one fact with one wording and one code, and a second copy of it is a
 * second answer to "what did the caller just fail with". The caller names itself
 * so the message still says where the send stopped.
 * @param caller - Log prefix of the send path raising this, e.g. `[session.sendMessage]`.
 * @param sessionId - Session the send was for.
 * @param deferredAgentIds - Agents held by a generation this runtime does not own.
 * @throws A {@link SessionStartError} naming the agents in both the field and the message.
 */
export function refuseTotalDeferral(caller: string, sessionId: string, deferredAgentIds: ReadonlySet<string>): never {
  const agentIds = [...deferredAgentIds];
  throw new SessionStartError(
    'agent-unavailable',
    `${caller} session ${sessionId} has no agent this runtime may drive: ${agentIds.join(', ')} ${
      agentIds.length === 1 ? 'is' : 'are'
    } held by another generation's provider session`,
    undefined,
    agentIds,
  );
}
