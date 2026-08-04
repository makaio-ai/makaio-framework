import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AdapterSessionCurrencyState, type IMakaioSession } from '@makaio/contracts';
import { SessionStorageSubjects } from './storage/namespace.js';

/** Resolved currency values a movement announcement implies for the session row. */
interface CurrencyTarget {
  /** Provider-confirmed ID to store, or `null` to clear the column. */
  readonly currentAdapterSessionId: string | null;
  /** Currency state to store alongside the ID. */
  readonly currentAdapterSessionIdState: AdapterSessionCurrencyState;
}

/**
 * Read the session row's currency state, normalizing rows that predate the
 * column (in-memory storage returns `undefined` rather than the DB default).
 * @param session - Session record loaded from storage
 * @returns Effective currency state
 */
function currentState(session: IMakaioSession): AdapterSessionCurrencyState {
  return session.currentAdapterSessionIdState ?? 'inherited';
}

/**
 * Registers the session-row adapter-session currency handler.
 *
 * Consumes `agent.adapterSession.moved` — the single seam every
 * provider-session movement producer converges on — and maintains the session
 * row's resume currency (`currentAdapterSessionId` +
 * `currentAdapterSessionIdState`).
 *
 * The origin identity `session.adapterSessionId` is deliberately never touched
 * here: it is write-once import provenance and the conflict key of the import
 * upsert's unique index. Splitting provenance from currency is what lets the
 * provider session move without invalidating import identity.
 *
 * **Lead-agent ownership.** Only the session's designated lead agent may move
 * the session-row currency. A member agent runs its own provider conversation;
 * its movements are recorded on the agent row (by the adapter) and must not
 * redirect the session's resume target. `adapterName` is checked as an
 * additional consistency guard so a foreign adapter's provider ID can never be
 * paired with the session's adapter identity.
 *
 * **No `session.updated` emission.** Session currency is runtime resume
 * plumbing, not presentation state: the UI reads the origin identity and never
 * this pair, so emitting a session-changed event here would invalidate
 * renderer caches on every provider rotation for no observable benefit. Add the
 * emission only together with a consumer that actually needs it.
 * @param bus - Message bus used by the session service
 * @returns Cleanup function
 */
export function registerAdapterSessionCurrencyHandler(bus: IMakaioBus): () => void {
  return bus.on(AgentSubjects.adapterSession.moved, async (ctx) => {
    const { agentId, sessionId, adapterName, adapterSessionId, confirmed } = ctx.payload;
    if (!sessionId) return;

    // The seam schema refines the flag/ID pairing, but that refinement is not a
    // guarantee at this point: the bus skips payload validation entirely in
    // production builds, and the exported protocol manifest drops refinements
    // (JSON Schema cannot express them), so an SDK publisher has no schema-level
    // signal that the combination is invalid. Both directions are ignored
    // rather than interpreted, because neither names a movement this handler
    // could apply: a confirmed movement without an ID advertises currency it
    // cannot name (and would fail the storage check constraint), and an
    // unconfirmed one carrying an ID advertises a successor the provider never
    // acknowledged. Reinterpreting the latter as a plain unconfirmed move would
    // clear the session's resume currency on a payload whose intent is
    // undefined; ignoring it leaves the currency at its previous value, the same
    // degradation a dropped movement already produces (see the #1140 note below).
    if (confirmed !== (adapterSessionId !== undefined)) return;

    // Past the pair guard the ID's presence *is* the confirmation flag, so
    // branching on it alone keeps the mapping total and lets it narrow.
    const target: CurrencyTarget =
      adapterSessionId === undefined
        ? { currentAdapterSessionId: null, currentAdapterSessionIdState: 'moved' }
        : { currentAdapterSessionId: adapterSessionId, currentAdapterSessionIdState: 'confirmed' };

    const result = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
    const session = result.handled ? result.data.session : null;
    if (!session) return;

    // TODO(#1140): movements announced *during* `adapter.startAgent` are still
    // dropped here. `startAgent` runs the agent's first dispatch before it emits
    // `session.agent.added`, so a start-with-message that rotates the provider
    // session announces the movement while the session row either has no lead
    // agent yet or still names the previous process's agent. The guard cannot be
    // widened to cover that window: "no/other lead agent recorded" is
    // indistinguishable from a member agent trying to redirect the session's
    // resume target, and a member agent must never win. Closing it properly
    // needs the lead designation to be established before the first dispatch —
    // a pre-start ownership claim, which is a lifecycle change beyond this seam.
    // Until then a dropped movement leaves the currency at its previous value;
    // the next movement from the (now designated) lead agent re-establishes it.
    if (session.leadAgentId !== agentId) return;
    if (session.adapterName !== undefined && session.adapterName !== adapterName) return;

    // Change-guarded: the seam re-announces on every unconfirmed dispatch until
    // the provider confirms, and enrichment-driven confirmations can repeat
    // across connector generations. Only a real transition reaches storage.
    const stateUnchanged = currentState(session) === target.currentAdapterSessionIdState;
    const idUnchanged = (session.currentAdapterSessionId ?? null) === target.currentAdapterSessionId;
    if (stateUnchanged && idUnchanged) return;

    // Targeted column update rather than the whole-record
    // `SessionStorageSubjects.set` path: `set` is a read-modify-write of a full
    // session snapshot, so a concurrent writer holding a pre-movement snapshot
    // would resurrect the abandoned provider session.
    //
    // The get→update sequence above is deliberately NOT compare-and-swap. Two
    // movement announcements for the same lead agent can interleave here: `emit`
    // runs handlers concurrently across independent producer chains (payload
    // enrichment, connector-swap completion, turn-dispatch rotation all call the
    // tracker without a shared lock), so the later announcement can lose the
    // write race and leave the row naming a superseded provider session. What
    // bounds the damage is the seam's re-announcement contract: the tracker
    // re-reports on every unconfirmed dispatch and every confirmation, so the
    // next movement re-establishes the correct currency, and a resume in between
    // targets a real (if older) provider session rather than a fabricated one.
    // A genuine fix is a row version or conditional update, which means a new
    // column, a per-dialect migration, and a versioned-write contract on
    // `storage:session.update` that every caller would have to honour — a
    // storage-wide concurrency model, not a repair of this handler. That belongs
    // in the same lifecycle decision as the startAgent-window drop above (#1140):
    // both want one owner for session-row currency writes.
    await bus.requestOptional(SessionStorageSubjects.update, {
      sessionId,
      ...target,
    });
  });
}
