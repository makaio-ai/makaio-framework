/**
 * The provider-session movement seam and its producer contract.
 *
 * Every producer that changes which provider session an agent is current on
 * (provider confirmation, connector swap, pre-confirmation rotation, cold
 * rehydration) announces that change here, and the service-tier currency
 * handler turns each announcement into the session row's resume currency.
 *
 * ## Seam invariant
 *
 * The session row must never advertise a provider session the agent has
 * stopped being current on. Because the only consumer is change-guarded and
 * an announcement is not persistent, that reduces to five producer duties:
 *
 * 1. **Delivered means acknowledged.** A movement counts as delivered only
 *    when {@link emitAdapterSessionMoved} resolves `true`. `bus.emit` runs
 *    local handlers before it resolves, so a `true` result means the currency
 *    write already happened; `false` means no consumer is known to have
 *    applied it. Only handlers on the producer's *own* bus instance are
 *    awaited, so this duty rests on the consumer always being one of them —
 *    see the consumer-locality and single-consumer notes in
 *    {@link emitAdapterSessionMoved} for why that holds and why `false` is
 *    currently exact.
 * 2. **Announce before the dependent action.** Producers `await` the
 *    announcement so the currency write is ordered ahead of whatever depends
 *    on it — the dispatch that abandons the old provider session, or the
 *    first event/row write that advertises the new one. Fire-and-forget leaves
 *    a window in which a concurrent attach reads superseded currency. The
 *    ordering attaches to an acknowledged delivery, not to the attempt: after
 *    a `false` result the producer continues *unordered* and depends on duties
 *    3 and 4 to re-deliver the movement.
 * 3. **An undelivered movement stays retryable.** The seam has no queue, and
 *    for a stable identity no *later* movement would arrive to re-establish
 *    it. So a producer that deduplicates announcements must key its guard on
 *    the last *acknowledged* announcement, never on the last observed
 *    identity — otherwise one rejected consumer loses the movement forever.
 * 4. **Retry state must outlive the announcement attempt.** No producer may
 *    advance state that a later retry compares against — the agent row's
 *    `adapterSessionId`, a cached identity, a dedup marker — past an
 *    unacknowledged announcement, unless a live retry anchor still holds the
 *    movement. In practice: route through {@link ConfirmedAdapterSessionTracker},
 *    whose `lastAnnounced` / `undelivered` markers are that anchor and which
 *    payload enrichment re-drives on the agent's next event. A producer must not
 *    assume its own trigger will fire again — the rotation signal behind an
 *    unconfirmed movement is one-shot, because the connector consumes its resume
 *    target in the same dispatch that raised it.
 * 5. **Occupancy evidence must precede the announcement.** The announcement is
 *    what publishes the new provider session as the session row's resume
 *    currency, and therefore what makes it discoverable as a resume target. So
 *    any state a concurrent attach reads to decide that session is *already
 *    occupied* must already name it when the announcement is dispatched —
 *    otherwise the attach resolves the new currency, finds no live writer, and
 *    claims the session for a second agent. In practice that state is the
 *    adapter's active-agent registry, which resolves occupancy through
 *    `AIAgent.currentAdapterSessionId`; the tracker caches a confirmed identity
 *    before announcing it, which is what satisfies this duty.
 *
 * Duties 4 and 5 pull in opposite directions only in appearance; together they
 * pin one order, because they govern two different kinds of state:
 *
 * ```
 * occupancy evidence  →  announcement  →  retry anchors
 * ```
 *
 * State a concurrent attach reads as *proof the session is taken* goes first
 * (duty 5). State a later retry reads as *proof the movement still needs
 * delivering* goes last (duty 4). Cold rehydration announcing before its row
 * write and a connector swap refreshing the registry before announcing are the
 * same rule seen from the two ends: the agent row is a retry anchor, the registry
 * is occupancy evidence.
 *
 * The duties govern *delivery* of a movement. Which movements a producer may
 * announce in the first place is the separate question
 * {@link providerCommittedAdapterSessionId} answers: a producer acting on a
 * session it just chose may announce it as confirmed, while one that only samples
 * connector state may not, because the identity a connector reports can be one an
 * already-made decision is about to abandon.
 *
 * Duty 1 is why {@link emitAdapterSessionMoved} reports failure by return
 * value instead of rejecting: the seam is advisory for the emitting agent, so
 * a failed announcement must not fail the turn or rehydrate that produced it,
 * but it must still be distinguishable from a delivered one.
 */
import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';

/**
 * Stable identity fields required to attribute a provider-session movement.
 */
export interface AdapterSessionMovementIdentity {
  /** Stable agent identifier. */
  readonly agentId: string;
  /** Adapter instance identifier. */
  readonly adapterId: string;
  /** Adapter type name (e.g. `'claude-code'`). */
  readonly adapterName: string;
  /** Owning Makaio session, when the agent runs inside one. */
  readonly sessionId: string | undefined;
}

/**
 * Movement outcome reported to the seam.
 *
 * Modeled as a union so the pairing invariant is unrepresentable to violate:
 * a confirmed movement always names its successor, an unconfirmed one has none.
 */
export type AdapterSessionMovement =
  | {
      /** The provider confirmed the new identity. */
      readonly confirmed: true;
      /** Provider-confirmed session ID that is now the resume currency. */
      readonly adapterSessionId: string;
    }
  | {
      /** The identity moved but no successor is confirmed yet. */
      readonly confirmed: false;
    };

/**
 * Announce a provider-session identity movement on the shared movement seam.
 *
 * Every movement producer (provider confirmation, connector swap,
 * pre-confirmation rotation, cold rehydration) routes through this function so
 * downstream currency tracking has exactly one contract to honour.
 *
 * Never rejects: the seam is advisory for the emitting agent — a failed
 * announcement must not fail the turn or the rehydrate that produced it.
 * Failure is reported through the return value instead, because a producer
 * that deduplicates announcements must not count a failed one as delivered:
 * the change-guarded consumer never saw it, and for a stable identity no
 * later movement would arrive to re-establish it.
 *
 * Producers must `await` this call. `bus.emit` resolves only after its local
 * handlers have run, so awaiting a `true` result is what orders the currency
 * write ahead of the action that depends on it: the dispatch that abandons the
 * old provider session, or the agent event that first advertises the new one.
 * Fire-and-forget would leave a window in which a resume attach reads the
 * superseded currency and targets an abandoned provider thread.
 * @param bus - Global bus carrying the `agent` namespace
 * @param identity - Emitting agent's stable identity fields
 * @param movement - Confirmed successor ID (if any) and confirmation flag
 * @returns Whether every local consumer acknowledged the announcement
 */
export async function emitAdapterSessionMoved(
  bus: IMakaioBus,
  identity: AdapterSessionMovementIdentity,
  movement: AdapterSessionMovement,
): Promise<boolean> {
  try {
    // Consumer locality. `bus.emit` awaits only local handlers, so "delivered"
    // would say nothing if the currency handler could sit on a different bus
    // peer than the producer. It cannot: every composition root that hosts an
    // adapter runtime also composes the session service on the same bus, whose
    // `onInit` registers `registerAdapterSessionCurrencyHandler`. The main
    // runtime pairs `prepareAdapterRuntime` with the framework core package set
    // (which only ever filters the session *orchestrator* out), and the remote
    // worker-node runtime composes the session service deliberately even though
    // it owns no database. There the transport carries the consumer's *own*
    // storage hop, and that is a correlated request rather than an event: the
    // handler awaits the authority's response, so `emit` still settles behind
    // the storage write. A runtime that hosted adapters *without* the session
    // service would break duty 1, and the repair would belong at that
    // composition root — or in an acknowledged emit contract at the bus — not in
    // a producer-side retry, which cannot observe a remote consumer at all.
    //
    // Single rejecting consumer by design. `bus.emit` starts every local
    // handler, then awaits `Promise.all`, so it rejects at the *first*
    // rejection while slower siblings keep running unawaited. That only
    // weakens duty 2 if some *other* handler can reject while the currency
    // write is still in flight — then this would report `false` before the
    // write settled and the caller would proceed unordered. Today it cannot:
    // `agent.adapterSession.moved` has exactly one local consumer that can
    // reject, the session-currency handler itself, so first rejection is also
    // last settlement and fail-fast equals settle-all. (The workflow engine's
    // namespace wildcard also observes this subject, but its handler is
    // synchronous and reports every failure in-band, so it never rejects.
    // Remote subscribers are irrelevant here: transport sends are awaited but
    // their errors are swallowed inside `emit`.)
    // A second *rejecting* local subscriber would break the equivalence, and
    // no producer-side change can restore it: either that subscriber handles
    // its own failures in-band like the workflow evaluator, or the seam needs
    // an emit path that waits for all local consumers to settle — a bus
    // contract change, to be decided at the bus, not patched around here.
    await bus.emit(AgentSubjects.adapterSession.moved, {
      agentId: identity.agentId,
      adapterId: identity.adapterId,
      adapterName: identity.adapterName,
      confirmed: movement.confirmed,
      ...(identity.sessionId !== undefined && { sessionId: identity.sessionId }),
      ...(movement.confirmed && { adapterSessionId: movement.adapterSessionId }),
    });
    return true;
  } catch (error) {
    console.warn(
      `[adapter-session-movement] Failed to announce provider-session movement for agent ${identity.agentId}:`,
      error,
    );
    return false;
  }
}

/**
 * The two facts a connector reports about its provider-session confirmation
 * state. Structural on purpose: `AIAgentConnector` satisfies it, and stating it
 * here keeps the seam free of a dependency on the connector layer.
 */
export interface AdapterSessionConfirmationSource {
  /** Provider session the connector is currently authoritative on, if any. */
  getConfirmedAdapterSessionId(): string | undefined;
  /** Whether declining native resume would rotate that session away. */
  movesProviderSessionOnSuppressedResume(): boolean;
}

/**
 * The connector's provider session as far as a *sampling* consumer may trust it.
 *
 * Two kinds of consumer read a connector's session identity, and only one may
 * read {@link AdapterSessionConfirmationSource.getConfirmedAdapterSessionId}
 * directly:
 *
 * - A producer with *intent* (a connector swap that resumes a chosen session,
 *   cold rehydration) announces the identity it deliberately targeted. The agent
 *   is current on that session because the producer just put it there, even
 *   while the provider has not committed to it yet.
 * - A *sampler* (payload enrichment on every emitted event, the pre-dispatch
 *   rotation test) has no intent of its own. It observes connector state and
 *   cannot tell an identity the agent still stands on from one a decision
 *   already made is about to abandon: a locally seeded resume target is reported
 *   as authoritative until the dispatch that discards it reaches the connector's
 *   queue, which happens *after* the executor announced the rotation and after
 *   `createMessageHandle` emitted the events enrichment runs on.
 *
 * A provider-committed identity is exactly the class a sampler may treat as
 * current: it cannot be abandoned without some producer announcing that movement
 * first. So samplers resolve the identity through here, which withholds the
 * reported ID for as long as the connector admits it would rotate away from it.
 * Sampling the raw accessor instead let enrichment announce an abandoned resume
 * target as `confirmed`, re-pointing the session row at the stale provider
 * thread the rotation had just cleared.
 * @param connector - Connector to interrogate
 * @returns Provider-committed session ID, or `undefined` when none is committed
 */
export function providerCommittedAdapterSessionId(connector: AdapterSessionConfirmationSource): string | undefined {
  return connector.movesProviderSessionOnSuppressedResume() ? undefined : connector.getConfirmedAdapterSessionId();
}

/**
 * The slice of an agent's runtime config the tracker reads and maintains.
 *
 * `AIAgentConfig` satisfies this structurally, so the owning agent hands its
 * own config over rather than plumbing four accessors through an options object.
 */
export interface ConfirmedAdapterSessionTrackerHost {
  /** Stable agent identifier. */
  readonly agentId: string;
  /** Adapter instance identifier. */
  readonly adapterId: string;
  /** Adapter type name. */
  readonly adapterName: string;
  /** Owning Makaio session, when the agent runs inside one. */
  readonly sessionId?: string;
  /**
   * The provider session later connector generations inherit as their resume
   * target, or `undefined` when the next generation must start fresh.
   *
   * Carries only the *datum*. Whether this agent participates in resume-target
   * inheritance at all is the tracker's own
   * {@link ConfirmedAdapterSessionTracker} policy state, so the field may be
   * cleared for a genuinely abandoned session without permanently converting the
   * agent to fresh-swap semantics.
   *
   * Mutable by design, and the tracker is its only writer once the agent is
   * constructed: an inheriting agent's target tracks the live
   * provider-confirmed continuation (re-pointed by {@link
   * ConfirmedAdapterSessionTracker.record}), is dropped when a movement
   * abandons it ({@link ConfirmedAdapterSessionTracker.recordUnconfirmedMove}),
   * and is replaced wholesale by an explicit resume decision ({@link
   * ConfirmedAdapterSessionTracker.adoptResumeTarget}).
   */
  resumeAdapterSessionId?: string;
}

/**
 * Owns the agent's confirmed provider-session identity and the movement seam.
 *
 * The cached identity bridges connector swaps: while the old connector is gone
 * and the replacement is not yet wired, the cache still carries the confirmed
 * ID for payload enrichment.
 *
 * Movements are announced from here because this is the single sink every
 * confirmed identity passes through — provider confirmation during payload
 * enrichment and connector-swap results alike.
 */
export class ConfirmedAdapterSessionTracker {
  private lastKnown?: string;

  /**
   * Last identity every local consumer acknowledged, tracked separately from
   * {@link lastKnown}: the cache must serve payload enrichment the moment the
   * provider confirms, but a failed announcement must stay announceable — for
   * a stable identity no later movement would arrive to re-deliver it, so the
   * next {@link record} of the same ID retries against this marker instead of
   * deduplicating against the cache.
   */
  private lastAnnounced?: string;

  /**
   * The one movement no consumer acknowledged yet, held until one does.
   *
   * {@link lastAnnounced} alone cannot carry an unconfirmed movement — it has no
   * successor ID to compare against, so a rejected one would simply vanish and
   * leave the session row advertising the abandoned provider session. Holding
   * the movement itself covers both kinds with one anchor, and holding the
   * *latest* one (rather than queueing) is correct because a movement is a
   * statement about the agent's current session: a newer statement supersedes
   * an older undelivered one.
   *
   * Retrying the movement verbatim matters for the unconfirmed kind. Until the
   * provider confirms a successor, payload enrichment still resolves the
   * abandoned identity from {@link lastKnown}; re-announcing *that* as confirmed
   * would re-assert currency on the very session the agent stopped being
   * current on.
   */
  private undelivered?: AdapterSessionMovement;

  /**
   * Whether this agent participates in resume-target inheritance.
   *
   * The policy half of what {@link ConfirmedAdapterSessionTrackerHost.resumeAdapterSessionId}
   * used to encode alone. The field's `!== undefined` state cannot answer the
   * policy question, because a target that was *abandoned* is indistinguishable
   * from one that never existed — and the two demand opposite handling: an agent
   * born without a target must never acquire one, while an agent whose target was
   * abandoned must re-point onto the successor the provider confirms next.
   *
   * Set from one rule, at the two moments an inheritance *decision* is made:
   * construction (the start-time target) and {@link adoptResumeTarget} (an
   * explicit per-swap resume decision). Movements never change it — they only
   * move or drop the datum.
   */
  private inheritsResumeTarget: boolean;

  private readonly bus: IMakaioBus;

  private readonly host: ConfirmedAdapterSessionTrackerHost;

  /**
   * Create a tracker bound to one agent's runtime config.
   * @param bus - Global bus carrying the `agent` namespace
   * @param host - Owning agent's runtime config
   */
  public constructor(bus: IMakaioBus, host: ConfirmedAdapterSessionTrackerHost) {
    this.bus = bus;
    this.host = host;
    this.inheritsResumeTarget = host.resumeAdapterSessionId !== undefined;
  }

  /** @returns Last confirmed provider session ID, or `undefined` when none was seen */
  public get lastKnownAdapterSessionId(): string | undefined {
    return this.lastKnown;
  }

  /**
   * Record the currently resolved provider session.
   *
   * Change-guarded: payload enrichment calls this for every emitted event, so
   * only a value that differs from the previously acknowledged announcement
   * counts as a movement worth announcing. A failed announcement leaves that
   * marker untouched, so the next enrichment call retries it.
   *
   * Awaiting the returned promise costs a movement announcement only when the
   * identity changed or a previous movement is still undelivered — the common
   * enrichment call re-records an already-acknowledged ID and resolves without
   * touching the bus.
   *
   * An unresolved identity does not update the cache: payload enrichment calls
   * this with `undefined` whenever the connector has no confirmed session yet
   * (between a swap and the replacement's first confirmation, for example), and
   * clearing the cache there would drop the last confirmed identity that
   * enrichment must keep reporting until a successor is confirmed. Only
   * {@link recordUnconfirmedMove} represents "the identity moved with no
   * successor", and it too leaves the cache intact. An unresolved identity does
   * still re-drive an undelivered movement — enrichment is the seam's only retry
   * clock, and an agent whose connector reports nothing is exactly the one whose
   * unconfirmed movement is still outstanding.
   * @param adapterSessionId - Resolved provider session ID, or `undefined`
   */
  public async record(adapterSessionId: string | undefined): Promise<void> {
    if (adapterSessionId !== undefined) {
      this.lastKnown = adapterSessionId;
      if (this.inheritsResumeTarget) {
        // Gated on the inheritance *policy*, not on the datum still being set.
        // That is what makes an abandoned target self-healing: {@link
        // recordUnconfirmedMove} drops the datum so no swap can resume the
        // abandoned thread, and the first identity the provider confirms
        // afterwards re-points inheritance onto that successor. Gating on the
        // datum instead would leave the agent on fresh-swap semantics forever,
        // silently ending continuity for a conversation the provider did resume.
        //
        // Sound only because every caller passes a provider-committed identity:
        // enrichment resolves the connector through
        // {@link providerCommittedAdapterSessionId} and hands this sink that
        // sample alone — never a cached predecessor, which after an unconfirmed
        // movement is deliberately the *abandoned* identity.
        this.host.resumeAdapterSessionId = adapterSessionId;
      }
      // Announcing a *confirmed* movement for anything that differs from the
      // last acknowledged one is only sound because no caller passes a
      // non-committed identity in: enrichment resolves the connector through
      // `providerCommittedAdapterSessionId`, so an armed resume target the
      // in-flight dispatch is about to abandon never arrives here as a
      // successor. The comparison deliberately stays against `lastAnnounced`
      // rather than `lastKnown` — duty 3 needs an undelivered announcement to
      // remain retryable, which dedup against the observed identity would break.
      if (adapterSessionId !== this.lastAnnounced) {
        await this.announce({ adapterSessionId, confirmed: true });
        return;
      }
    }
    if (this.undelivered !== undefined) {
      await this.announce(this.undelivered);
    }
  }

  /**
   * Announce that the provider session moved with no confirmed successor.
   *
   * The cached identity is intentionally left alone: it still describes the
   * last confirmed session, which payload enrichment must keep reporting until
   * the provider confirms the replacement.
   *
   * Awaited by the dispatch that discards the resume target, so the session row
   * stops advertising the abandoned provider session before the provider is
   * asked to start a new one.
   *
   * Retryability cannot be left to the producer here. The connector consumes its
   * resume target one-shot during that same dispatch, so the rotation signal
   * that triggered this movement does not fire again — an undelivered
   * announcement survives only because {@link announce} parks it.
   *
   * The agent-side resume target is dropped, while
   * {@link inheritsResumeTarget} stays set. Keeping the datum would let a later
   * connector swap that carries no explicit resume decision inherit it through
   * `buildConfigFactoryInput` and native-resume the very thread this movement
   * marked abandoned — reachable whenever the turn fails or idles before a
   * successor is confirmed, since out-of-band swaps (MCP session context,
   * credential rotation) get no history-injection compensation from the
   * service's per-send-message `hasConnectorSwap` derivation. Dropping only the
   * datum is what keeps that safe *and* recoverable: the policy bit re-points
   * inheritance onto the successor as soon as the provider confirms one.
   *
   * The delivery markers are deliberately untouched: {@link lastAnnounced} and
   * {@link undelivered} are the seam's retry anchors, and the abandoned datum is
   * not one — no retry compares against it.
   *
   * Cleared before the announcement rather than after, because it is the same
   * class of state duty 2 orders: config a concurrent swap reads to pick its
   * resume target must stop naming the abandoned session no later than the
   * currency write that stops advertising it.
   * @returns Promise resolving once the movement has been announced
   */
  public async recordUnconfirmedMove(): Promise<void> {
    this.host.resumeAdapterSessionId = undefined;
    await this.announce({ confirmed: false });
  }

  /**
   * Adopt an explicit resume decision as the agent's inherited resume target.
   *
   * The connector-swap coordinator publishes a per-generation resume decision
   * here instead of writing the config field itself, so the inheritance policy
   * and the inherited datum cannot drift apart. Both follow from the one rule
   * the constructor also applies: a decision that names a session makes the
   * agent inherit it, a decision to start fresh takes inheritance away.
   *
   * That is what re-arms an agent born without a resume target when an explicit
   * resume swap later gives it one — without it, the fresh-born agent would keep
   * a stale target across the confirmations that follow.
   * @param resumeAdapterSessionId - Session later generations inherit, or
   *   `undefined` to make them start fresh
   */
  public adoptResumeTarget(resumeAdapterSessionId: string | undefined): void {
    this.host.resumeAdapterSessionId = resumeAdapterSessionId;
    this.inheritsResumeTarget = resumeAdapterSessionId !== undefined;
  }

  /**
   * Announce one movement and update the delivery markers from its outcome.
   *
   * Sole writer of {@link lastAnnounced} and {@link undelivered}, so the seam's
   * "delivered means acknowledged" duty holds for every movement kind through
   * one code path instead of once per producer method.
   *
   * A delivered *unconfirmed* movement deliberately leaves {@link lastAnnounced}
   * standing. The marker then no longer describes the row (which now advertises
   * no ID), but it is what keeps {@link lastKnown} — intentionally still the
   * abandoned identity — from being re-announced as confirmed when enrichment
   * falls back to the cache during the window before a successor is confirmed.
   * @param movement - Movement to announce
   */
  private async announce(movement: AdapterSessionMovement): Promise<void> {
    const delivered = await emitAdapterSessionMoved(this.bus, this.identity(), movement);
    this.undelivered = delivered ? undefined : movement;
    if (delivered && movement.confirmed) {
      this.lastAnnounced = movement.adapterSessionId;
    }
  }

  /**
   * Project the host config onto the seam's identity shape.
   * @returns Identity fields for a movement announcement
   */
  private identity(): AdapterSessionMovementIdentity {
    return {
      agentId: this.host.agentId,
      adapterId: this.host.adapterId,
      adapterName: this.host.adapterName,
      sessionId: this.host.sessionId,
    };
  }
}
