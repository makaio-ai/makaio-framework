import {
  resolveResumableAdapterSessionId,
  type AdapterSessionCurrencySnapshot,
  type IMakaioSession,
  type MakaioSessionAgent,
} from '@makaio/contracts';

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
 * Row fields that carry a currency trias, as the storage records optionally
 * spell them.
 *
 * Session rows and agent rows carry the same three facts under the same names;
 * both leave them absent until something writes them. Declared once so the two
 * readers below cannot drift into resolving one row differently from the other.
 */
type OptionalCurrencyFields = {
  adapterSessionId?: string | undefined;
  currentAdapterSessionId?: string | undefined;
  currentAdapterSessionIdState?: AdapterSessionCurrencySnapshot['currentAdapterSessionIdState'];
};

/**
 * Read a row's currency trias as the total value the resolver expects.
 *
 * Absent state is `'inherited'`: rows written before the currency pair existed,
 * and rows the in-memory backend created, never moved.
 * @param row - Session or agent record whose currency is being read
 * @returns The row's currency trias with absent halves normalized
 */
function toCurrencySnapshot(row: OptionalCurrencyFields): AdapterSessionCurrencySnapshot {
  return {
    adapterSessionId: row.adapterSessionId ?? null,
    currentAdapterSessionId: row.currentAdapterSessionId ?? null,
    currentAdapterSessionIdState: row.currentAdapterSessionIdState ?? 'inherited',
  };
}

/**
 * Project a currency trias onto the resume identity its owner may target.
 * @param currency - Currency trias of a session or agent row
 * @returns Resume identity implied by that currency
 */
function resumeIdentityFromCurrency(currency: AdapterSessionCurrencySnapshot): SessionResumeIdentity {
  return {
    adapterSessionId: resolveResumableAdapterSessionId(currency) ?? undefined,
    movedUnconfirmed: currency.currentAdapterSessionIdState === 'moved',
  };
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
 * **Compress children are never a resume source.** Provider-side compaction is
 * in place — same provider session ID, same transcript — so the row that
 * carries the provider identity is the lineage root, and the compress children
 * the transcript importer synthesizes carry no currency at all. Passing one here
 * therefore resolves to "nothing resumable", which is the correct answer for
 * that row: the conversation lives on its root. A caller holding a compress
 * child resolves the root first; this function deliberately does not, because it
 * takes a row and not a bus, and a lineage walk hidden behind a pure projection
 * would be a storage read no caller asked for.
 * @param session - Session record loaded from storage
 * @returns Resolved resume identity for this session
 */
export function resolveSessionResumeIdentity(session: IMakaioSession): SessionResumeIdentity {
  return resumeIdentityFromCurrency(toCurrencySnapshot(session));
}

/**
 * Resolve the resume currency that applies to one agent of a session.
 *
 * Currency is **agent-owned**: the ownership seam settles it onto the agent row
 * and mirrors it onto the session row only while the agent is the designated
 * lead. So an agent whose currency has been settled answers this question by
 * itself, and the session row is consulted only as a legacy fallback — for rows
 * written before the agent row could carry currency at all.
 *
 * | # | Agent                                                | Resume currency     |
 * |---|------------------------------------------------------|---------------------|
 * | 1 | has settled currency (`currencyFence > 0`)            | its own currency    |
 * | 2 | unsettled, and the session names it as lead          | the session row     |
 * | 3 | unsettled, no lead named, session was imported       | the session row     |
 * | 4 | anything else                                        | its own currency    |
 *
 * Why each branch:
 *
 * 1. A non-zero `currencyFence` is evidence that the ownership seam has written
 *    this row. From that point the agent row is at least as fresh as the session
 *    row, because the session mirror is written *from* it, in the same
 *    transaction.
 * 2. An unsettled agent the session names as lead: the pre-Wave-2 currency
 *    handler recorded the lead's movement on the session row *while this agent
 *    was the named lead*, so the row's state — including a `'moved'` — is
 *    attributable to exactly this agent.
 * 3. The only "no lead" fallback that survives. An imported session that never
 *    had a lead carries provider identity from the import itself, attributable
 *    to no other agent because there is none.
 * 4. Everything else resolves from its **own** currency and origin. A blanket
 *    no-lead fallback would hand a member the *lead's* provider conversation.
 *
 * Membership is keyed on `session.leadAgentId` rather than the agent row's
 * `role` column, because `leadAgentId` is the exact designation the seam gates
 * its session mirror on. Keying on `role` would let the reader and the writer
 * disagree about who owns the row.
 * @param session - Session record loaded from storage
 * @param agent - Agent record whose resume currency is being resolved; its
 *   currency fields decide branch 1, so a caller must not narrow them away
 * @returns Resolved resume identity for this agent
 */
export function resolveAgentResumeIdentity(
  session: IMakaioSession,
  agent: Pick<
    MakaioSessionAgent,
    'agentId' | 'adapterSessionId' | 'currentAdapterSessionId' | 'currentAdapterSessionIdState' | 'currencyFence'
  >,
): SessionResumeIdentity {
  const agentSettled = (agent.currencyFence ?? 0) > 0;
  if (agentSettled) {
    return resumeIdentityFromCurrency(toCurrencySnapshot(agent));
  }
  if (session.leadAgentId === agent.agentId) {
    return resolveSessionResumeIdentity(session);
  }
  if (session.leadAgentId === undefined && session.isImported === true) {
    return resolveSessionResumeIdentity(session);
  }
  return resumeIdentityFromCurrency(toCurrencySnapshot(agent));
}
