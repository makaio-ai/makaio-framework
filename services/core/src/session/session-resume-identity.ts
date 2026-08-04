import type { IMakaioSession, MakaioSessionAgent } from '@makaio/contracts';

/**
 * The provider session a resume operation may legitimately target right now.
 *
 * Produced by {@link resolveSessionResumeIdentity} so that every role in a
 * resume path — locality evaluation, live-writer detection, and the resume
 * target handed to the adapter — reads the same value. Reading
 * `session.adapterSessionId` directly in those roles is what let them diverge:
 * that column is immutable origin provenance, not resume currency.
 */
export interface SessionResumeIdentity {
  /**
   * Provider session ID that is valid resume currency, or `undefined` when the
   * session has none.
   */
  readonly adapterSessionId: string | undefined;
  /**
   * Whether the provider session moved without provider confirmation.
   *
   * When `true`, native resume is impossible regardless of every other
   * structural signal — there is no provider session that still holds the
   * conversation. Callers degrade to fresh-with-history.
   */
  readonly movedUnconfirmed: boolean;
}

/**
 * Resolve the tri-state resume currency of a session row.
 *
 * | `currentAdapterSessionIdState` | resume currency                         |
 * |-------------------------------|-----------------------------------------|
 * | `'inherited'` (or absent)     | `session.adapterSessionId` (origin)     |
 * | `'confirmed'`                 | `session.currentAdapterSessionId`       |
 * | `'moved'`                     | none — degrade to fresh-with-history    |
 *
 * Absent state is treated as `'inherited'`: rows written before the currency
 * pair existed, and rows created by the in-memory storage backend, never moved.
 * @param session - Session record loaded from storage
 * @returns Resolved resume identity for this session
 */
export function resolveSessionResumeIdentity(session: IMakaioSession): SessionResumeIdentity {
  switch (session.currentAdapterSessionIdState) {
    case 'confirmed':
      return { adapterSessionId: session.currentAdapterSessionId, movedUnconfirmed: false };
    case 'moved':
      return { adapterSessionId: undefined, movedUnconfirmed: true };
    default:
      return { adapterSessionId: session.adapterSessionId, movedUnconfirmed: false };
  }
}

/**
 * Resolve the resume currency that applies to one agent of a session.
 *
 * Session-row currency is **lead-owned**: only the session's designated lead
 * agent may move it (see the lead-agent-ownership rule in
 * `registerAdapterSessionCurrencyHandler`). So the row's currency — including a
 * `'moved'` state — is a statement about the lead's provider conversation, not
 * about the session as a whole. A member agent runs its own provider thread and
 * carries its own identity on the agent row, so resolving the session row for a
 * member would degrade an agent whose provider conversation is still intact.
 *
 * | agent                          | resume currency                     |
 * |--------------------------------|-------------------------------------|
 * | designated lead                | {@link resolveSessionResumeIdentity}|
 * | member                         | `agent.adapterSessionId`            |
 * | any, while no lead is named    | {@link resolveSessionResumeIdentity}|
 *
 * The third row is deliberate fail-safe attribution, not an oversight: the
 * currency handler can only have written the row's state while the writing agent
 * *was* the named lead, so an absent `leadAgentId` (lead removed, or the
 * still-open `startAgent` designation window — TODO(#1140)) leaves the state
 * unattributable. Applying it to every agent then over-degrades rather than
 * resuming a provider session that may have been abandoned.
 *
 * Membership is keyed on `session.leadAgentId` rather than the agent row's
 * `role` column, because `leadAgentId` is the exact designation the currency
 * writer gates on. Keying on `role` would let the reader and the writer disagree
 * about who owns the row.
 *
 * A member's own movements are **not** represented here, because they are not
 * represented anywhere: the movement seam's only persistent consumer is the
 * session row, and `agent.adapterSessionId` is write-once, so a member's
 * unconfirmed movement is dropped rather than recorded.
 * TODO(#1140): a member that rotated its provider session in the process that
 * went down therefore still resumes its last confirmed ID. That gap is not
 * introduced or widened here — it applies identically whenever the lead did not
 * happen to move — but closing it needs the agent row to carry its own currency
 * pair (column plus per-dialect migration), i.e. the same "one owner for
 * currency writes" lifecycle decision #1140 already blocks on.
 * @param session - Session record loaded from storage
 * @param agent - Agent record whose resume currency is being resolved
 * @returns Resolved resume identity for this agent
 */
export function resolveAgentResumeIdentity(
  session: IMakaioSession,
  agent: Pick<MakaioSessionAgent, 'agentId' | 'adapterSessionId'>,
): SessionResumeIdentity {
  if (session.leadAgentId === undefined || session.leadAgentId === agent.agentId) {
    return resolveSessionResumeIdentity(session);
  }
  return { adapterSessionId: agent.adapterSessionId, movedUnconfirmed: false };
}
