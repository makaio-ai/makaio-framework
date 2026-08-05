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
 * Whether a send named its target agents itself.
 *
 * A predicate rather than a `=== 'explicit'` comparison, so the named ids narrow
 * out of the spec where they are needed: classifying the spec and getting the ids
 * out of it is one question.
 * @param targetSpec - The request's `agentIds`, as the schema models it.
 * @returns `true` when the spec is an id array, narrowing it to one.
 */
function isExplicitTargetSpec(targetSpec: readonly string[] | 'all' | undefined): targetSpec is readonly string[] {
  return resolveSendTargetForm(targetSpec) === 'explicit';
}

/**
 * Admit a send to the fresh-start branch, or refuse the targets it stated.
 *
 * **Decided before that branch runs, and the ordering is the whole point.**
 * `lead-default` is the only form that asks for *an* agent rather than asserting
 * something about the ones the session has; every other form states a target,
 * and a session with no agents answers every such statement the same way. So
 * only `lead-default` may bring a session its first agent:
 *
 * - **`explicit`** — the session cannot contain the ids the caller named, and
 *   substituting a freshly started agent would answer a question nobody asked.
 * - **`'all'`** — "all of them" of nothing is not a delivery, exactly as it is
 *   not one when every target defers ({@link refuseTotalDeferral}).
 *
 * Either send was already decided at this moment, so starting a lead first only
 * changes *what the failure leaves behind* — an agent row, a lead designation
 * and a reserved provider session created by a send that never delivered.
 *
 * This admits, it does not clear: a named agent the session *has* may still turn
 * out to be undrivable, which is what the post-recovery validation decides.
 *
 * `agent-unavailable` is reused rather than invented, exactly as
 * {@link refuseTotalDeferral} reuses it: the code means "this runtime may not act
 * for these agents", and an agent that does not exist is the strongest form of
 * that, not a different fact. Only the named form carries `deferredAgentIds` — a
 * throw makes the response field unreachable, so the ids travel on the error
 * where there are ids to travel; a broadcast named none, and inventing a payload
 * for it would say the session held agents it never held.
 * @param caller - Log prefix of the send path raising this, e.g. `[session.sendMessage]`.
 * @param sessionId - Session the send was for.
 * @param session - Session as this send resolved it, after any in-flight start.
 * @param targetSpec - The request's `agentIds`, as the schema models it.
 * @throws A {@link SessionStartError} naming the agents, when the send named any.
 */
export function admitFreshStartTargets(
  caller: string,
  sessionId: string,
  session: IMakaioSession,
  targetSpec: readonly string[] | 'all' | undefined,
): void {
  if (session.agents.length > 0 || resolveSendTargetForm(targetSpec) === 'lead-default') return;
  if (isExplicitTargetSpec(targetSpec)) {
    const agentIds = [...targetSpec];
    throw new SessionStartError(
      'agent-unavailable',
      `${caller} session ${sessionId} has no agents, so it cannot have the ${
        agentIds.length === 1 ? 'agent' : 'agents'
      } this send named: ${agentIds.join(', ')}`,
      undefined,
      agentIds,
    );
  }
  throw new SessionStartError(
    'agent-unavailable',
    `${caller} session ${sessionId} has no agents, so a send targeting all of them has none to reach`,
  );
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
